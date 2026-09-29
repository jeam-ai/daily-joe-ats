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
  type OdooAnalysis,
  type OdooReports,
  type OdooMatrix,
} from "@/lib/odoo";
import { config, SafeError } from "./config";
import { seal, unseal } from "@/lib/auth/security";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
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
  excessiveWorkedHours: z.number().min(1).max(24).default(14),
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
async function saveExceptions(tx: Transaction, batch: OdooBatch) {
  // Named read model: the encrypted batch remains the source of truth. Stable
  // batch/day IDs let HR inspect exceptions without duplicating analyses.
  const rows = batch.records.filter(
    (r) =>
      r.issues.length ||
      r.review.status === "For Review" ||
      r.review.history.length,
  );
  for (const r of rows)
    await putRecord(tx, "odoo_exceptions", `${batch.id}:${r.id}`, {
      id: `${batch.id}:${r.id}`,
      batchId: batch.id,
      name: r.employee,
      date: r.date,
      results: r.results,
      issues: r.issues,
      worked: r.worked,
      expected: r.expected,
      status: r.review.status,
      review: r.review,
      createdAt: batch.analyzedAt,
    });
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
  await transaction(async (tx) => {
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
  });
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
    return unseal<OdooBatch>(encrypted, config().encryptionKey);
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
    const batch = unseal<OdooBatch>(encrypted, config().encryptionKey);
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
    return transaction(async (tx) => {
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
            if (saved?.history.length || saved?.classification || saved?.note)
              record.review = saved;
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
export async function reviewOdoo(input: unknown, user: User) {
  requireTimekeeping(user);
  const parsed = z
    .object({
      id: z.string(),
      recordId: z.string(),
      revision: z.number().int(),
      status: z.enum(reviewStatuses),
      note: z.string().max(4000),
      classification: z.enum(attendanceClassifications).optional(),
      correctedInOdoo: z.boolean().optional(),
      correctionNote: z.string().max(4000).optional(),
      duplicateResolution: z
        .object({
          retainedSourceRows: z.array(z.number().int().positive()).max(100),
          disregardedSourceRows: z.array(z.number().int().positive()).max(100),
        })
        .optional(),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Choose a valid review status and note.");
  const body = parsed.data;
  if (body.status !== "For Review" && !body.note.trim())
    throw new SafeError(
      "Record a verification note before resolving this attendance record.",
    );
  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "odoo_batches", body.id);
    if (!encrypted) throw new SafeError("Analysis not found.", 404);
    const batch = unseal<OdooBatch>(encrypted, config().encryptionKey);
    if (batch.revision !== body.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before saving your review.",
        409,
      );
    const row = batch.records.find((r) => r.id === body.recordId);
    if (!row) throw new SafeError("Attendance record not found.", 404);
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
        new Set(chosen).size !== chosen.length
      )
        throw new SafeError(
          "Choose at least one valid source row to retain; a source row cannot be both retained and disregarded.",
          409,
        );
    }
    const permittedClassifications = row.results.includes("Negative Attendance")
      ? ["Late", "Undertime", "Early Out"]
      : row.results.includes("No Attendance")
        ? ["Absent", "Day Off", "Leave", "System / Data Issue", "Other"]
        : [];
    if (
      body.classification &&
      !permittedClassifications.includes(body.classification)
    )
      throw new SafeError(
        "That classification is not available for this attendance record.",
        409,
      );
    if (
      permittedClassifications.length &&
      body.status !== "For Review" &&
      !body.classification &&
      !row.review.classification
    )
      throw new SafeError(
        "Confirm the attendance classification before resolving this record.",
        409,
      );
    const now = new Date().toISOString(),
      previous = row.review.status;
    row.review = {
      status: body.status,
      note: body.note,
      classification: body.classification || row.review.classification,
      correctedInOdoo:
        body.correctedInOdoo ?? row.review.correctedInOdoo ?? false,
      correctionNote: body.correctionNote || row.review.correctionNote || "",
      duplicateResolution:
        body.duplicateResolution || row.review.duplicateResolution,
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
    batch.revision++;
    await saveExceptions(tx, batch);
    await putRecord(tx, "odoo_reviews", crypto.randomUUID(), {
      batchId: batch.id,
      recordId: row.id,
      employee: row.employee,
      date: row.date,
      previous,
      status: body.status,
      note: body.note,
      duplicateResolution: body.duplicateResolution,
      reviewer: user.email,
      createdAt: now,
    });
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
      employeeKey: z.string().min(1).max(300),
      recordIds: z.array(z.string().min(1)).min(1).max(31),
      note: z.string().trim().min(1).max(4000),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Choose one employee's eligible overtime records.");
  const body = parsed.data;
  if (new Set(body.recordIds).size !== body.recordIds.length)
    throw new SafeError("Each overtime record can only be completed once.");

  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "odoo_batches", body.id);
    if (!encrypted) throw new SafeError("Analysis not found.", 404);
    const batch = unseal<OdooBatch>(encrypted, config().encryptionKey);
    if (batch.revision !== body.revision)
      throw new SafeError(
        "Another HR user updated this analysis. Reload it before completing overtime.",
        409,
      );
    const rows = batch.records.filter((row) => body.recordIds.includes(row.id));
    if (rows.length !== body.recordIds.length)
      throw new SafeError("One or more attendance records no longer exist.", 404);
    if (
      rows.some(
        (row) =>
          (row.employeeId || row.employee) !== body.employeeKey ||
          !isNormalOvertimeForSeparateMonitoring(row),
      )
    )
      throw new SafeError(
        "Only clean normal-overtime records for one employee can be completed here. Other attendance exceptions require individual HR review.",
        409,
      );

    const now = new Date().toISOString();
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
      await putRecord(tx, "odoo_reviews", crypto.randomUUID(), {
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
      });
    }
    batch.revision++;
    await saveExceptions(tx, batch);
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
    await audit(tx, user.email, "timekeeping.normal_overtime_completed", undefined, {
      batchId: batch.id,
      employeeKey: body.employeeKey,
      recordIds: body.recordIds,
      note: body.note,
    });
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
