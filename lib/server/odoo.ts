import "server-only";
import ExcelJS from "exceljs";
import { formatDate } from "@/lib/dates";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  analyzeOdooAsync,
  ODOO_ANALYSIS_VERSION,
  odooDate,
  parseOdooReports,
  reviewStatuses,
  attendanceClassifications,
  correctDuplicateAttendance,
  upgradeOdooAnalysis,
  isZeroExpectedHoursSystemIssue,
  type OdooAnalysis,
  type OdooReports,
  type OdooMatrix,
  type OdooDay,
} from "@/lib/odoo";
import { config, SafeError } from "./config";
import { seal, unseal } from "@/lib/auth/security";
import {
  transaction,
  retryableTransaction,
  readTransaction,
  readRecord,
  putRecord,
  putRecords,
  putRecordEntries,
  type Transaction,
} from "./database";
import { audit, getState, saveState } from "./repository";
import { withDeadline } from "./deadline";
import type { User } from "@/types";
import {
  defaultTimekeepingCutoffGraceDays,
  timekeepingCutoffExpiresAt,
} from "@/lib/timekeeping-retention";
import { isNormalOvertimeForSeparateMonitoring } from "@/lib/timekeeping-workflow";
import {
  matchesAttendance,
  refreshAttendanceAutomation,
} from "@/lib/attendance-automation";
export const odooRulesSchema = z.object({
  timezone: z.enum(["Asia/Manila", "Asia/Singapore", "UTC"]),
  start: z.union([
    z.literal(""),
    z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  ]),
  end: z.union([
    z.literal(""),
    z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  ]),
  graceMinutes: z.number().min(0).max(120),
  overtimeMinutes: z.number().min(0).max(240),
  overtimeRounding: z.enum(["nearest", "completed"]).default("nearest"),
  excessiveWorkedHours: z.number().min(9).max(24).default(16),
  discrepancyMinutes: z.number().min(0).max(120),
  expectedHours: z.number().min(0).max(24).nullable(),
  workDays: z.array(z.number().int().min(0).max(6)).max(7),
});
export type OdooBatch = OdooAnalysis & {
  id: string;
  revision: number;
  uploadedBy: string;
  uploadedAt: string;
  analyzedAt: string;
  fingerprint: string;
  savedAt?: string;
  savedBy?: string;
  retentionExpiresAt?: string;
  // Metadata only: the prior cutoff analysis itself is removed on replacement.
  previousBatchId?: string;
};
async function saveExceptions(
  tx: Transaction,
  batch: OdooBatch,
  records = batch.records,
) {
  await putRecordEntries(tx, exceptionEntries(batch, records));
}
function exceptionEntries(batch: OdooBatch, records: OdooDay[]) {
  // Named read model: the encrypted batch remains the source of truth. Stable
  // batch/day IDs let HR inspect exceptions without duplicating analyses.
  const rows = records.filter(
    (r) =>
      r.issues.length ||
      r.review.status === "For Review" ||
      r.review.history.length,
  );
  return rows.map((r) => ({
    collection: "odoo_exceptions",
    id: `${batch.id}:${r.id}`,
    value: {
      id: `${batch.id}:${r.id}`,
      batchId: batch.id,
      name: r.employee,
      date: r.date,
      results: r.results,
      issues: r.issues,
      worked: r.worked,
      severity: r.severity,
      calculation: r.calculation,
      automationReason: r.automationReason,
      expected: r.expected,
      status: r.review.status,
      review: r.review,
      createdAt: batch.analyzedAt,
    },
  }));
}
type Upload = {
  uploadedAt: string;
  actor: string;
  expiresAt: number;
  reports: OdooReports;
};
export function requireTimekeeping(user: User) {
  if (!["Admin", "HR Generalist", "Office Assistant"].includes(user.role))
    throw new SafeError("Timekeeping requires HR operations access.", 403);
}
export async function readOdooWorkbook(bytes: Buffer, filename: string) {
  if (
    bytes.length > 8 * 1024 * 1024 ||
    !filename.toLowerCase().endsWith(".xlsx") ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b
  )
    throw new SafeError("Choose an original Odoo .xlsx file under 8 MB.");
  const book = new ExcelJS.Workbook();
  try {
    await withDeadline(book.xlsx.load(bytes as never), 20000);
  } catch {
    throw new SafeError(
      "We couldn't read this workbook. Export an unlocked, undamaged .xlsx copy from Odoo.",
    );
  }
  const sheet = book.worksheets.find((s) => s.rowCount >= 2);
  if (!sheet || sheet.rowCount > 12000 || sheet.columnCount > 100)
    throw new SafeError(
      "Choose an Odoo report with up to 12,000 rows and 100 columns.",
    );
  const matrix: OdooMatrix = [];
  for (let row = 1; row <= sheet.rowCount; row++) {
    if (row % 250 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    matrix.push(
      Array.from({ length: sheet.columnCount }, (_, i) => {
        const cell = sheet.getRow(row).getCell(i + 1);
        const v = cell.value;
        if (v === null) return null;
        if (v instanceof Date)
          return v.toISOString().slice(0, 19).replace("T", " ");
        if (typeof v === "number") return v;
        if (typeof v === "object" && "result" in v)
          return typeof v.result === "number"
            ? v.result
            : String(v.result ?? "");
        return cell.text.slice(0, 2000);
      }),
    );
  }
  return {
    matrix,
    source: {
      filename,
      sheet: sheet.name,
      hash: createHash("sha256").update(bytes).digest("hex"),
      rows: sheet.rowCount,
    },
  };
}
export async function previewOdoo(
  attendance: { name: string; bytes: Buffer },
  pivot: { name: string; bytes: Buffer },
  user: User,
) {
  requireTimekeeping(user);
  const [a, p] = await Promise.all([
    readOdooWorkbook(attendance.bytes, attendance.name),
    readOdooWorkbook(pivot.bytes, pivot.name),
  ]);
  let reports: OdooReports;
  try {
    reports = parseOdooReports(a.matrix, p.matrix, [a.source, p.source]);
  } catch (e) {
    throw new SafeError((e as Error).message);
  }
  const id = crypto.randomUUID();
  await retryableTransaction(async (tx) => {
    await putRecord(
      tx,
      "odoo_uploads",
      id,
      seal(
        {
          uploadedAt: new Date().toISOString(),
          actor: user.email,
          expiresAt: Date.now() + 1800000,
          reports,
        },
        config().encryptionKey,
      ),
    );
    await audit(tx, user.email, "timekeeping.uploaded", undefined, {
      id,
      period: reports.period,
      sourceHashes: reports.sources.map((s) => s.hash),
    });
  }, 3);
  return {
    id,
    period: reports.period,
    sources: reports.sources,
    attendanceRows: reports.attendance.length,
    pivotRows: reports.pivot.length,
    employees: new Set(
      [...reports.attendance, ...reports.pivot].map((r) => r.employee),
    ).size,
    aliases: reports.aliases,
    warnings: reports.warnings,
  };
}
export async function getOdooBatch(id: string, user: User) {
  requireTimekeeping(user);
  return readTransaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "odoo_batches", id);
    if (!encrypted)
      throw new SafeError(
        "Analysis not found. Choose a saved cutoff or upload both reports.",
        404,
      );
    return upgradeOdooAnalysis(
      unseal<OdooBatch>(encrypted, config().encryptionKey),
    );
  });
}
export async function listOdooBatches(user: User) {
  requireTimekeeping(user);
  return readTransaction(async (tx) => {
    const rows = await tx.query(
      "SELECT id,payload FROM records WHERE collection=$1",
      ["odoo_index"],
    );
    return rows
      .map((r) => JSON.parse(String(r.payload)))
      .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))
      .slice(0, 30);
  });
}

async function cutoffRetentionDeadline(tx: Transaction, periodEnd: string) {
  const configured = await tx.query(
    "SELECT days FROM retention_policies WHERE name='timekeeping_cutoff_grace_days'",
  );
  const grace = Number(configured[0]?.days);
  return timekeepingCutoffExpiresAt(
    periodEnd,
    Number.isInteger(grace) && grace >= 0
      ? grace
      : defaultTimekeepingCutoffGraceDays,
  );
}

export async function checkpointOdoo(
  input: { id: string; revision: number },
  user: User,
) {
  requireTimekeeping(user);
  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "odoo_batches", input.id);
    if (!encrypted) throw new SafeError("Analysis not found.", 404);
    const batch = upgradeOdooAnalysis(
      unseal<OdooBatch>(encrypted, config().encryptionKey),
    );
    if (batch.revision !== input.revision)
      throw new SafeError(
        "Another HR user updated this cutoff. Reload it before saving your checkpoint.",
        409,
      );
    const now = new Date().toISOString();
    batch.revision++;
    batch.savedAt = now;
    batch.savedBy = user.email;
    batch.retentionExpiresAt =
      (await cutoffRetentionDeadline(tx, batch.period.end)) || undefined;
    await putRecord(
      tx,
      "odoo_batches",
      batch.id,
      seal(batch, config().encryptionKey),
    );
    const index = await readRecord<Record<string, unknown>>(
      tx,
      "odoo_index",
      batch.id,
    );
    if (index)
      await putRecord(tx, "odoo_index", batch.id, {
        ...index,
        savedAt: batch.savedAt,
        retentionExpiresAt: batch.retentionExpiresAt,
      });
    await audit(tx, user.email, "timekeeping.checkpoint_saved", undefined, {
      batchId: batch.id,
      period: batch.period,
      retentionExpiresAt: batch.retentionExpiresAt,
    });
    return batch;
  });
}
export async function analyzeOdooUpload(
  id: string,
  input: unknown,
  aliases: Record<string, string>,
  user: User,
  progress?: (processed: number, total: number) => Promise<void>,
  cutoff?: { start: string; end: string },
) {
  requireTimekeeping(user);
  const rules = odooRulesSchema.safeParse(input);
  if (!rules.success)
    throw new SafeError(
      "Check the attendance rules and enter valid times and hour values.",
    );
  const enc = await readTransaction((tx) =>
    readRecord<string>(tx, "odoo_uploads", id),
  );
  {
    if (!enc)
      throw new SafeError(
        "Upload both Odoo reports again. The preview is no longer available.",
        409,
      );
    const upload = unseal<Upload>(enc, config().encryptionKey);
    if (upload.actor !== user.email || upload.expiresAt < Date.now())
      throw new SafeError(
        "This preview belongs to another user or has expired. Upload both files again.",
        409,
      );
    const period = cutoff || upload.reports.period;
    if (
      odooDate(period.start) !== period.start ||
      odooDate(period.end) !== period.end ||
      period.start > period.end ||
      Date.parse(period.end) - Date.parse(period.start) > 93 * 86400000
    )
      throw new SafeError("Choose a valid payroll cutoff start and end date.");
    if (
      period.start > upload.reports.period.start ||
      period.end < upload.reports.period.end
    )
      throw new SafeError(
        "The selected cutoff must include every dated record in both reports.",
      );
    const reports = {
      ...upload.reports,
      period: {
        ...upload.reports.period,
        start: period.start,
        end: period.end,
      },
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: ODOO_ANALYSIS_VERSION,
          hashes: upload.reports.sources.map((s) => s.hash),
          period: reports.period,
          rules: rules.data,
          aliases: Object.entries(aliases).sort(),
        }),
      )
      .digest("hex");
    let analysis: OdooAnalysis;
    try {
      analysis = await analyzeOdooAsync(reports, rules.data, aliases, progress);
    } catch (e) {
      throw new SafeError((e as Error).message);
    }
    return retryableTransaction(async (tx) => {
      const existing = await readRecord<string>(
        tx,
        "odoo_fingerprints",
        fingerprint,
      );
      if (existing) {
        const stored = await readRecord<string>(tx, "odoo_batches", existing);
        if (stored)
          return {
            ...unseal<OdooBatch>(stored, config().encryptionKey),
            reused: true,
          };
      }
      const cutoff = `${analysis.period.start}:${analysis.period.end}`,
        previousBatchId = await readRecord<string>(tx, "odoo_cutoffs", cutoff),
        now = new Date().toISOString();
      // Reprocessing a cutoff must not discard HR's already-confirmed
      // classification, resolution, or Odoo-correction trail. Carry it to the
      // matching employee/day in the replacement analysis; the new source
      // data remains authoritative for calculated results.
      if (previousBatchId) {
        const previous = await readRecord<string>(
          tx,
          "odoo_batches",
          previousBatchId,
        );
        if (previous) {
          const prior = unseal<OdooBatch>(previous, config().encryptionKey);
          const reviews = new Map(
            prior.records.map((record) => [
              `${record.employeeId || record.employee}|${record.date}`,
              record.review,
            ]),
          );
          for (const record of analysis.records) {
            const saved = reviews.get(
              `${record.employeeId || record.employee}|${record.date}`,
            );
            if (
              saved?.history.length ||
              saved?.note ||
              (saved?.reviewer && saved.reviewer !== "System")
            )
              record.review = structuredClone(saved);
            const correction = saved?.duplicateResolution;
            if (
              correction?.retainedRecords?.length &&
              correction.disregardedRecords?.length &&
              record.raw.length > 1
            ) {
              const signature = (source: OdooDay["raw"][number]) =>
                JSON.stringify([
                  source.row,
                  source.employee,
                  source.employeeId,
                  source.checkIn,
                  source.checkOut,
                  source.worked,
                  source.overtime,
                  source.extra,
                ]);
              const original = new Set(
                [
                  ...correction.retainedRecords,
                  ...correction.disregardedRecords,
                ].map(signature),
              );
              if (
                original.size === record.raw.length &&
                record.raw.every((source) => original.has(signature(source)))
              )
                correctDuplicateAttendance(
                  record,
                  analysis.rules,
                  correction.retainedSourceRows,
                );
            }
          }
        }
      }
      const batch: OdooBatch = {
        ...analysis,
        id: crypto.randomUUID(),
        revision: 1,
        uploadedBy: user.email,
        uploadedAt: upload.uploadedAt || now,
        analyzedAt: now,
        fingerprint,
        savedAt: now,
        savedBy: user.email,
        retentionExpiresAt:
          (await cutoffRetentionDeadline(tx, analysis.period.end)) || undefined,
        previousBatchId: previousBatchId || undefined,
      };
      for (const record of batch.records) {
        if (record.review.reviewer === "System" && !record.review.reviewedAt)
          record.review.reviewedAt = now;
        refreshAttendanceAutomation(record, batch.rules);
      }
      await putRecord(
        tx,
        "odoo_batches",
        batch.id,
        seal(batch, config().encryptionKey),
      );
      await putRecord(tx, "odoo_fingerprints", fingerprint, batch.id);
      await saveExceptions(tx, batch);
      await putRecord(tx, "odoo_cutoffs", cutoff, batch.id);
      // A cutoff has exactly one saved analysis. The parsed result is retained;
      // raw uploads and the replaced analysis are not used as a file archive.
      await tx.query(
        "DELETE FROM records WHERE collection='odoo_uploads' AND id=$1",
        [id],
      );
      if (previousBatchId && previousBatchId !== batch.id) {
        await tx.query(
          "DELETE FROM records WHERE collection IN ('odoo_batches','odoo_sources','odoo_index') AND id=$1",
          [previousBatchId],
        );
        await tx.query(
          "DELETE FROM records WHERE collection='odoo_exceptions' AND id LIKE $1",
          [`${previousBatchId}:%`],
        );
        // Keep the append-only review/correction history. The active cutoff
        // pointer changes, but HR can still audit the earlier source version.
        await tx.query(
          "DELETE FROM records WHERE collection='odoo_fingerprints' AND payload=$1",
          [JSON.stringify(previousBatchId)],
        );
        await tx.query(
          "INSERT INTO retention_cleanup_metrics(month,metric,count,updated_at) VALUES($1,$2,1,$3) ON CONFLICT(month,metric) DO UPDATE SET count=retention_cleanup_metrics.count+1,updated_at=excluded.updated_at",
          [now.slice(0, 7), "timekeeping_analyses_replaced", now],
        );
      }
      const flagged = batch.records.filter(
        (r) => r.review.status === "For Review",
      ).length;
      await putRecord(tx, "odoo_index", batch.id, {
        id: batch.id,
        period: batch.period,
        analyzedAt: now,
        savedAt: batch.savedAt,
        retentionExpiresAt: batch.retentionExpiresAt,
        employees: new Set(batch.records.map((r) => r.employeeId || r.employee))
          .size,
        records: batch.records.length,
        flagged,
      });
      await putRecord(tx, "odoo_rules", user.email, {
        rules: rules.data,
        aliases,
      });
      const state = await getState(tx);
      state.notifications.push({
        id: `timekeeping-${batch.id}`,
        title: "Timekeeping Analysis Complete",
        description: `${formatDate(batch.period.start, state.preferences)} to ${formatDate(batch.period.end, state.preferences)} · ${flagged} records require HR review.`,
        href: `/timekeeping?batch=${batch.id}`,
        date: now,
        read: false,
      });
      await saveState(tx, state, { sync: false });
      await audit(tx, user.email, "timekeeping.analyzed", undefined, {
        id: batch.id,
        cutoff,
        version: batch.version,
        replacedBatchId: previousBatchId || undefined,
        flagged,
      });
      return batch;
    });
  }
}
const attendanceReviewSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  revision: z.number().int(),
  status: z.enum(reviewStatuses),
  note: z.string().max(4000).default(""),
  classification: z.enum(attendanceClassifications).optional(),
  correctedInOdoo: z.boolean().optional(),
  correctionNote: z.string().max(4000).optional(),
  duplicateResolution: z
    .object({
      retainedSourceRows: z.array(z.number().int().positive()).max(100),
      disregardedSourceRows: z.array(z.number().int().positive()).max(100),
    })
    .optional(),
});
function applyAttendanceReview(
  row: OdooDay,
  body: z.infer<typeof attendanceReviewSchema>,
  batch: OdooBatch,
  user: User,
  now: string,
) {
  if (body.duplicateResolution) {
    if (!row.results.includes("Multiple Entries"))
      throw new SafeError(
        "A duplicate source selection is only available for multiple attendance entries.",
        409,
      );
    const sourceRows = new Set(row.raw.map((source) => source.row));
    const chosen = [
      ...body.duplicateResolution.retainedSourceRows,
      ...body.duplicateResolution.disregardedSourceRows,
    ];
    if (
      !body.duplicateResolution.retainedSourceRows.length ||
      chosen.some((sourceRow) => !sourceRows.has(sourceRow)) ||
      new Set(chosen).size !== chosen.length ||
      chosen.length !== sourceRows.size
    )
      throw new SafeError(
        "Choose at least one valid source row to retain and account for every entry exactly once.",
        409,
      );
  }
  if (
    body.duplicateResolution &&
    body.status !== "For Review" &&
    body.duplicateResolution.disregardedSourceRows.length
  )
    correctDuplicateAttendance(
      row,
      batch.rules,
      body.duplicateResolution.retainedSourceRows,
    );
  const permittedClassifications = row.results.includes("Negative Attendance")
    ? ["Late", "Undertime", "Early Out"]
    : row.results.includes("No Attendance") || row.results.includes("Leave")
      ? ["Absent", "Day Off", "Leave", "System / Data Issue", "Other"]
      : isZeroExpectedHoursSystemIssue(row)
        ? ["System / Data Issue"]
        : ["System / Data Issue", "Other"];
  if (
    body.classification &&
    !permittedClassifications.includes(body.classification)
  )
    throw new SafeError(
      "That classification is not available for this attendance record.",
      409,
    );
  if (
    (row.results.includes("Negative Attendance") ||
      row.results.includes("No Attendance") ||
      isZeroExpectedHoursSystemIssue(row)) &&
    body.status !== "For Review" &&
    !body.classification &&
    !row.review.classification
  )
    throw new SafeError(
      "Confirm the attendance classification before resolving this record.",
      409,
    );
  const previous = row.review.status;
  row.review = {
    status: body.status,
    note: body.note,
    classification: body.classification || row.review.classification,
    correctedInOdoo:
      body.correctedInOdoo ?? row.review.correctedInOdoo ?? false,
    correctionNote: body.correctionNote || row.review.correctionNote || "",
    duplicateResolution: row.review.duplicateResolution?.disregardedRecords
      ?.length
      ? row.review.duplicateResolution
      : body.duplicateResolution || row.review.duplicateResolution,
    reviewer: user.email,
    reviewedAt: now,
    history: [
      ...row.review.history,
      {
        previous,
        next: body.status,
        note: body.note,
        reviewer: user.email,
        timestamp: now,
      },
    ],
  };
  refreshAttendanceAutomation(row, batch.rules);
  return previous;
}

/** Resolve the entire filtered selection in one audited, revision-checked transaction. */
export async function bulkReviewAttendance(input: unknown, user: User) {
  requireTimekeeping(user);
  const body = z
    .object({
      id: z.string(),
      revision: z.number().int(),
      recordIds: z.array(z.string()).max(20000).optional(),
      filters: z
        .object({
          query: z.string().optional(),
          status: z.string().optional(),
          result: z.string().optional(),
          date: z.string().optional(),
          department: z.string().optional(),
          location: z.string().optional(),
          severity: z.string().optional(),
          schedule: z.string().optional(),
          employee: z.string().optional(),
        })
        .optional(),
      allFiltered: z.boolean().default(false),
      expectedCount: z.number().int().positive(),
      operation: z.enum([
        "resolve",
        "confirm-overtime",
        "correction",
        "reason",
        "note",
        "reopen",
      ]),
      classification: z.enum(attendanceClassifications).optional(),
      note: z.string().trim().max(4000).default(""),
      confirmed: z.literal(true),
    })
    .safeParse(input);
  if (!body.success)
    throw new SafeError("Confirm a valid attendance selection and action.");
  const data = body.data;
  if (
    !data.allFiltered &&
    (!data.recordIds?.length ||
      new Set(data.recordIds).size !== data.recordIds.length)
  )
    throw new SafeError("Select attendance records once.");
  if (["note", "correction"].includes(data.operation) && !data.note)
    throw new SafeError("Enter a note for this action.");
  if (data.operation === "reason" && !data.classification)
    throw new SafeError("Choose an attendance reason.");
  return transaction(async (tx) => {
    const { batch, index } = await readReviewBatch(tx, data.id);
    if (batch.revision !== data.revision)
      throw new SafeError(
        "This cutoff changed. Reload before applying the bulk action.",
        409,
      );
    const ids = new Set(data.recordIds);
    const rows = batch.records.filter((r) =>
      data.allFiltered
        ? matchesAttendance(r, data.filters || {})
        : ids.has(r.id),
    );
    if (
      rows.length !== data.expectedCount ||
      (!data.allFiltered && rows.length !== ids.size)
    )
      throw new SafeError(
        "The selection changed. Review the current filtered records.",
        409,
      );
    if (
      data.operation === "confirm-overtime" &&
      rows.some(
        (r) =>
          !r.results.includes("Overtime") ||
          r.results.some(
            (v) => !["Overtime", "Normal", "Late", "Early Out"].includes(v),
          ) ||
          r.issues.length,
      )
    )
      throw new SafeError(
        "Select valid overtime records. Data errors and excessive overtime need validation first.",
        409,
      );
    const now = new Date().toISOString();
    const reviews = rows.map((row) => {
      const previousReview = structuredClone(row.review);
      applyAttendanceReview(
        row,
        {
          id: data.id,
          revision: data.revision,
          recordId: row.id,
          status:
            data.operation === "reopen" || data.operation === "correction"
              ? "For Review"
              : ["resolve", "confirm-overtime"].includes(data.operation)
                ? "Resolved"
                : row.review.status,
          note: data.note
            ? [row.review.note, data.note].filter(Boolean).join("\n")
            : row.review.note,
          classification: data.classification,
        },
        batch,
        user,
        now,
      );
      return {
        collection: "odoo_reviews",
        id: crypto.randomUUID(),
        value: {
          batchId: batch.id,
          recordId: row.id,
          previousReview,
          review: row.review,
          operation: data.operation,
          reviewer: user.email,
          createdAt: now,
        },
      };
    });
    batch.revision++;
    await persistReviewBatch(tx, batch, index, rows, reviews);
    await audit(tx, user.email, "timekeeping.bulk_reviewed", undefined, {
      batchId: batch.id,
      operation: data.operation,
      recordIds: rows.map((r) => r.id),
      note: data.note,
    });
    return batch;
  });
}

async function readReviewBatch(tx: Transaction, id: string) {
  const entries = await tx.query(
    "SELECT collection,payload FROM records WHERE id=$1 AND collection IN ('odoo_batches','odoo_index')",
    [id],
  );
  const encrypted = entries.find(
    (entry) => entry.collection === "odoo_batches",
  );
  if (!encrypted) throw new SafeError("Analysis not found.", 404);
  const index = entries.find((entry) => entry.collection === "odoo_index");
  return {
    batch: upgradeOdooAnalysis(
      unseal<OdooBatch>(
        JSON.parse(String(encrypted.payload)),
        config().encryptionKey,
      ),
    ),
    index: index
      ? (JSON.parse(String(index.payload)) as Record<string, unknown>)
      : null,
  };
}

async function persistReviewBatch(
  tx: Transaction,
  batch: OdooBatch,
  index: Record<string, unknown> | null,
  rows: OdooDay[],
  reviews: { collection: string; id: string; value: unknown }[],
) {
  await putRecordEntries(tx, [
    ...exceptionEntries(batch, rows),
    ...reviews,
    {
      collection: "odoo_batches",
      id: batch.id,
      value: seal(batch, config().encryptionKey),
    },
    ...(index
      ? [
          {
            collection: "odoo_index",
            id: batch.id,
            value: {
              ...index,
              flagged: batch.records.filter(
                (row) => row.review.status === "For Review",
              ).length,
            },
          },
        ]
      : []),
  ]);
}

export async function resolveEmployeeAttendance(input: unknown, user: User) {
  requireTimekeeping(user);
  const body = z
    .object({
      id: z.string(),
      revision: z.number().int(),
      employeeKey: z.string().min(1),
      records: z
        .array(
          attendanceReviewSchema.pick({
            recordId: true,
            classification: true,
            duplicateResolution: true,
          }),
        )
        .min(1)
        .max(94),
      note: z.string().max(4000).default(""),
    })
    .safeParse(input);
  if (!body.success)
    throw new SafeError("Choose attendance records for one employee.");
  const data = body.data;
  if (
    new Set(data.records.map((row) => row.recordId)).size !==
    data.records.length
  )
    throw new SafeError("Choose each attendance record only once.");
  return transaction(async (tx) => {
    const { batch, index } = await readReviewBatch(tx, data.id);
    if (batch.revision !== data.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before resolving records.",
        409,
      );
    const now = new Date().toISOString();
    const rows: OdooDay[] = [];
    const reviews: { collection: string; id: string; value: unknown }[] = [];
    for (const decision of data.records) {
      const row = batch.records.find(
        (record) => record.id === decision.recordId,
      );
      if (!row || (row.employeeId || row.employee) !== data.employeeKey)
        throw new SafeError(
          "All selected records must belong to the same employee.",
          409,
        );
      if (
        !["For Review", "Corrected"].includes(row.review.status) &&
        !row.review.correctedInOdoo
      )
        throw new SafeError("A selected record is already resolved.", 409);
      if (
        row.results.includes("Multiple Entries") &&
        !decision.duplicateResolution &&
        !row.review.duplicateResolution
      )
        throw new SafeError(
          "Select the attendance rows to retain before resolving duplicate records.",
          409,
        );
      const previous = applyAttendanceReview(
        row,
        {
          ...decision,
          id: data.id,
          revision: data.revision,
          status: "Resolved",
          note: data.note || row.review.note,
        },
        batch,
        user,
        now,
      );
      rows.push(row);
      reviews.push({
        collection: "odoo_reviews",
        id: crypto.randomUUID(),
        value: {
          batchId: batch.id,
          recordId: row.id,
          employee: row.employee,
          date: row.date,
          previous,
          status: "Resolved",
          note: row.review.note,
          classification: row.review.classification,
          duplicateResolution: row.review.duplicateResolution,
          reviewer: user.email,
          createdAt: now,
        },
      });
    }
    batch.revision++;
    await persistReviewBatch(tx, batch, index, rows, reviews);
    await audit(tx, user.email, "timekeeping.employee_resolved", undefined, {
      batchId: batch.id,
      employeeKey: data.employeeKey,
      recordIds: rows.map((row) => row.id),
      note: data.note,
    });
    return batch;
  });
}

export async function resolveZeroExpectedHours(input: unknown, user: User) {
  requireTimekeeping(user);
  const parsed = z
    .object({
      id: z.string(),
      revision: z.number().int(),
      note: z.string().max(4000).default(""),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Choose a valid cutoff and system error note.");
  const body = parsed.data;
  return transaction(async (tx) => {
    const { batch, index } = await readReviewBatch(tx, body.id);
    if (batch.revision !== body.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before resolving system errors.",
        409,
      );
    const rows = batch.records.filter(
      (row) =>
        row.review.status === "For Review" &&
        isZeroExpectedHoursSystemIssue(row),
    );
    if (!rows.length)
      throw new SafeError(
        "No zero expected hours system errors remain for review.",
        409,
      );
    const now = new Date().toISOString();
    const note =
      body.note.trim() ||
      "System / Data Issue: Odoo reported 0 expected hours. Recorded working hours were verified.";
    const reviews = rows.map((row) => {
      const previous = applyAttendanceReview(
        row,
        {
          id: body.id,
          revision: body.revision,
          recordId: row.id,
          status: "Resolved",
          note,
          classification: "System / Data Issue",
        },
        batch,
        user,
        now,
      );
      return {
        collection: "odoo_reviews",
        id: crypto.randomUUID(),
        value: {
          batchId: batch.id,
          recordId: row.id,
          employee: row.employee,
          date: row.date,
          previous,
          status: "Resolved",
          classification: "System / Data Issue",
          note,
          reviewer: user.email,
          createdAt: now,
        },
      };
    });
    batch.revision++;
    await persistReviewBatch(tx, batch, index, rows, reviews);
    await audit(
      tx,
      user.email,
      "timekeeping.zero_expected_hours_resolved",
      undefined,
      { batchId: batch.id, recordIds: rows.map((row) => row.id), note },
    );
    return batch;
  });
}

export async function reviewOdoo(input: unknown, user: User) {
  requireTimekeeping(user);
  const parsed = attendanceReviewSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError("Choose a valid review status and note.");
  const body = parsed.data;
  return transaction(async (tx) => {
    const { batch, index } = await readReviewBatch(tx, body.id);
    if (batch.revision !== body.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before saving your review.",
        409,
      );
    const row = batch.records.find((r) => r.id === body.recordId);
    if (!row) throw new SafeError("Attendance record not found.", 404);
    const now = new Date().toISOString();
    const previous = applyAttendanceReview(row, body, batch, user, now);
    batch.revision++;
    const reviewEntry = {
      collection: "odoo_reviews",
      id: crypto.randomUUID(),
      value: {
        batchId: batch.id,
        recordId: row.id,
        employee: row.employee,
        date: row.date,
        previous,
        status: body.status,
        note: body.note,
        duplicateResolution: row.review.duplicateResolution,
        reviewer: user.email,
        createdAt: now,
      },
    };
    await persistReviewBatch(tx, batch, index, [row], [reviewEntry]);
    await audit(tx, user.email, "timekeeping.reviewed", undefined, {
      batchId: batch.id,
      recordId: row.id,
      previous,
      next: body.status,
      note: body.note,
    });
    return batch;
  });
}

export async function completeNormalOvertimeForEmployee(
  input: unknown,
  user: User,
) {
  requireTimekeeping(user);
  const parsed = z
    .object({
      id: z.string(),
      revision: z.number().int(),
      scope: z.enum(["employee", "cutoff"]).default("employee"),
      employeeKey: z.string().min(1).max(300).optional(),
      recordIds: z.array(z.string().min(1)).min(1).max(94).optional(),
      note: z.string().trim().max(4000).default(""),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Choose one employee's eligible overtime records.");
  const body = parsed.data;
  if (
    body.scope === "employee" &&
    (!body.employeeKey || !body.recordIds?.length)
  )
    throw new SafeError("Choose one employee’s overtime-only records.");
  if (body.recordIds && new Set(body.recordIds).size !== body.recordIds.length)
    throw new SafeError("Each overtime record can only be completed once.");

  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "odoo_batches", body.id);
    if (!encrypted) throw new SafeError("Analysis not found.", 404);
    const batch = upgradeOdooAnalysis(
      unseal<OdooBatch>(encrypted, config().encryptionKey),
    );
    if (batch.revision !== body.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before completing overtime.",
        409,
      );
    // Derive cutoff-wide selection on the server, independent of filters and pagination.
    const rows =
      body.scope === "cutoff"
        ? batch.records.filter(isNormalOvertimeForSeparateMonitoring)
        : batch.records.filter((row) => body.recordIds!.includes(row.id));
    if (!rows.length)
      throw new SafeError("No overtime-only records remain for review.", 409);
    if (body.scope === "employee" && rows.length !== body.recordIds!.length)
      throw new SafeError(
        "One or more attendance records no longer exist.",
        404,
      );
    if (
      rows.some(
        (row) =>
          (body.scope === "employee" &&
            (row.employeeId || row.employee) !== body.employeeKey) ||
          !isNormalOvertimeForSeparateMonitoring(row),
      )
    )
      throw new SafeError(
        "Only records with exactly one classification, Overtime, can be completed here. Mixed classifications require individual HR review.",
        409,
      );

    const now = new Date().toISOString();
    const reviews: { id: string; value: unknown }[] = [];
    for (const row of rows) {
      const previous = row.review.status;
      row.review = {
        ...row.review,
        status: "Resolved",
        note: body.note,
        reviewer: user.email,
        reviewedAt: now,
        history: [
          ...row.review.history,
          {
            previous,
            next: "Resolved",
            note: body.note,
            reviewer: user.email,
            timestamp: now,
          },
        ],
      };
      refreshAttendanceAutomation(row, batch.rules);
      reviews.push({
        id: crypto.randomUUID(),
        value: {
          batchId: batch.id,
          recordId: row.id,
          employee: row.employee,
          date: row.date,
          previous,
          status: "Resolved",
          note: body.note,
          reviewer: user.email,
          createdAt: now,
          action: "normal_overtime_completed",
        },
      });
    }
    batch.revision++;
    await putRecords(tx, "odoo_reviews", reviews);
    await saveExceptions(tx, batch, rows);
    await putRecord(
      tx,
      "odoo_batches",
      batch.id,
      seal(batch, config().encryptionKey),
    );
    const index = await readRecord<Record<string, unknown>>(
      tx,
      "odoo_index",
      batch.id,
    );
    if (index)
      await putRecord(tx, "odoo_index", batch.id, {
        ...index,
        flagged: batch.records.filter((r) => r.review.status === "For Review")
          .length,
      });
    await audit(
      tx,
      user.email,
      "timekeeping.normal_overtime_completed",
      undefined,
      {
        batchId: batch.id,
        employeeKey: body.employeeKey,
        scope: body.scope,
        recordCount: rows.length,
        employeeCount: new Set(
          rows.map((row) => row.employeeId || row.employee),
        ).size,
        recordIds: rows.map((row) => row.id),
        note: body.note,
      },
    );
    return batch;
  });
}
export async function exportOdoo(batch: OdooBatch, csv: boolean) {
  const headers = [
    "Employee",
    "Employee ID",
    "Date",
    "Department",
    "Branch / location",
    `Check In (${batch.rules.timezone})`,
    `Check Out (${batch.rules.timezone})`,
    "Raw Worked Hours",
    "Pivot Worked Hours",
    "Expected Hours",
    "Calculated Difference",
    "Pivot Difference",
    "Balance",
    "Over Time",
    "Extra Hours",
    "Result",
    "Attendance Classification",
    "Review Status",
    "Corrected in Odoo",
    "Odoo Correction Note",
    "Resolution Note",
    "Reviewer",
    "Reviewed At",
    "Multiple Entries",
    "Attendance Source Rows",
    "Pivot Source Rows",
    "Source Files",
    "Review Notes",
    "Duplicate Correction History",
    "Severity",
    "Schedule",
    "Exact attendance (minutes)",
    "Credited overtime (minutes)",
    "Additional minutes",
    "Calculation / classification reason",
  ];
  const localTime = (iso: string) =>
    iso
      ? new Date(iso).toLocaleString("en-PH", {
          timeZone: batch.rules.timezone,
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      : "";
  const data = batch.records.map((r) => [
    r.employee,
    r.employeeId || "",
    r.date,
    r.department,
    r.location,
    localTime(r.checkIn),
    localTime(r.checkOut),
    r.rawWorked,
    r.pivotWorked,
    r.expected,
    r.difference,
    r.pivotDifference,
    r.balance,
    r.overtime,
    r.extra,
    r.results.join("; "),
    r.review.classification || "",
    r.review.status,
    r.review.correctedInOdoo ? "Yes" : "No",
    r.review.correctionNote || "",
    r.review.note,
    r.review.reviewer,
    r.review.reviewedAt,
    r.raw.length > 1 ? "Yes" : "No",
    r.raw.map((s) => s.row).join(", "),
    r.pivot.map((s) => s.row).join(", "),
    batch.sources.map((s) => s.filename).join("; "),
    r.issues.join("; "),
    r.review.duplicateResolution?.disregardedRecords?.length
      ? `Previously multiple entries; corrected. Removed source rows: ${r.review.duplicateResolution.disregardedSourceRows.join(", ")}`
      : "",
    r.severity,
    r.schedule,
    r.calculation?.totalMinutes,
    r.calculation?.creditedMinutes,
    r.calculation?.additionalMinutes,
    r.automationReason,
  ]);
  const safe = (v: unknown) => {
    const text = String(v ?? "");
    return /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
  };
  if (csv)
    return Buffer.from(
      "\uFEFF" +
        [headers, ...data]
          .map((row) =>
            row.map((v) => `"${safe(v).replaceAll('"', '""')}"`).join(","),
          )
          .join("\r\n"),
    );
  const book = new ExcelJS.Workbook();
  const summary = book.addWorksheet("Summary");
  const sheet = book.addWorksheet("Attendance review", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(headers);
  data.forEach((row) =>
    sheet.addRow(row.map((v) => (typeof v === "number" ? v : safe(v)))),
  );
  sheet.getRow(1).font = { bold: true, color: { argb: "FF243A51" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE5EFFB" },
  };
  sheet.getRow(1).height = 30;
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: sheet.rowCount, column: headers.length },
  };
  sheet.columns.forEach((c, i) => {
    c.width = i === 0 ? 28 : i >= 15 ? 26 : 20;
  });
  for (let c = 8; c <= 15; c++) sheet.getColumn(c).numFmt = "0.00";
  const source = book.addWorksheet("Source and rules");
  source.addRows([
    ["Daily Joe Careers", "Timekeeping"],
    ["Cutoff", `${batch.period.start} to ${batch.period.end}`],
    ["Uploaded by", batch.uploadedBy],
    ["Uploaded at", batch.uploadedAt],
    ["Analysis version", batch.version],
    ["Timezone", batch.rules.timezone],
    ...Object.entries(batch.rules)
      .filter(([k]) => k !== "timezone")
      .map(([k, v]) => [k, String(v ?? "Not configured")]),
    ...batch.sources.map((s) => [s.filename, `${s.sheet} · SHA-256 ${s.hash}`]),
    [
      "Review notice",
      "Detected conditions come from uploaded Odoo reports. For negative or missing attendance, HR—not the system—confirms the classification before payroll or employee action.",
    ],
  ]);
  source.getColumn(1).width = 32;
  source.getColumn(2).width = 100;

  summary.addRows([
    ["Daily Joe Careers — attendance summary", "Count / value"],
    ["Cutoff", `${batch.period.start} to ${batch.period.end}`],
    ["Employee-days", batch.records.length],
    [
      "Employee source identities",
      new Set(batch.records.map((r) => r.employeeId || r.employee)).size,
    ],
    ...[...new Set(batch.records.flatMap((r) => r.results))].map((result) => [
      result,
      batch.records.filter((r) => r.results.includes(result)).length,
    ]),
    ...[...new Set(batch.records.map((r) => r.review.status))].map((status) => [
      status,
      batch.records.filter((r) => r.review.status === status).length,
    ]),
    [
      "Notice",
      "Calculated classifications require HR review before payroll or employee action.",
    ],
  ]);
  summary.columns = [{ width: 48 }, { width: 85 }];
  summary.getRow(1).font = { bold: true };
  for (const [name, predicate] of [
    [
      "Exceptions",
      (r: OdooBatch["records"][number]) =>
        r.issues.length > 0 ||
        r.results.some((v) =>
          /Missing|Incomplete|Multiple|Mismatch|Discrepancy|Review/i.test(v),
        ),
    ],
    ["Multiple Entries", (r: OdooBatch["records"][number]) => r.raw.length > 1],
  ] as const) {
    const detail = book.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    detail.addRow(headers);
    batch.records.forEach((r, i) => {
      if (predicate(r))
        detail.addRow(
          data[i].map((v) => (typeof v === "number" ? v : safe(v))),
        );
    });
    detail.getRow(1).font = { bold: true };
    detail.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5EFFB" },
    };
    detail.columns.forEach((c, i) => {
      c.width = i === 0 ? 28 : 24;
    });
    detail.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, detail.rowCount), column: headers.length },
    };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
