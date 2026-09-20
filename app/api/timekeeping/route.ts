import { after } from "next/server";
import {
  createTimekeepingJob,
  getTimekeepingJob,
  retryTimekeepingJob,
  runTimekeepingJob,
} from "@/lib/server/timekeeping-jobs";
import { audit } from "@/lib/server/repository";
import { reportIssue } from "@/lib/server/diagnostics";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import {
  transaction,
  readTransaction,
  readRecord,
} from "@/lib/server/database";
import {
  analyzeOdooUpload,
  exportOdoo,
  getOdooBatch,
  listOdooBatches,
  previewOdoo,
  requireTimekeeping,
  reviewOdoo,
  odooRulesSchema,
} from "@/lib/server/odoo";
import { putRecord } from "@/lib/server/database";
import { z } from "zod";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    requireTimekeeping(user);
    const jobId = new URL(request.url).searchParams.get("job");
    if (jobId) {
      const job = await getTimekeepingJob(jobId, user);
      if (job.status === "Queued") after(() => runTimekeepingJob(jobId, user));
      return Response.json(
        { job },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const id = new URL(request.url).searchParams.get("batch");
    return Response.json(
      id
        ? { batch: await getOdooBatch(id, user) }
        : {
            batches: await listOdooBatches(user),
            template: await readTransaction((tx) =>
              readRecord(tx, "odoo_rules", user.email),
            ),
          },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (!(error instanceof SafeError) || error.status >= 500)
      await reportIssue("timekeeping.failed");
    return safeError(error);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    if (request.headers.get("x-djc-dataset") === "demo")
      throw new SafeError(
        "Exit Demo before changing real timekeeping records.",
        403,
      );
    const user = await requireUser();
    requireTimekeeping(user);
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      if (Number(request.headers.get("content-length")) > 17 * 1024 * 1024)
        throw new SafeError("Each Odoo report must be under 8 MB.");
      const form = await request.formData(),
        attendance = form.get("attendance"),
        pivot = form.get("pivot");
      if (
        !(attendance instanceof File) ||
        !(pivot instanceof File) ||
        !attendance.size ||
        !pivot.size
      )
        throw new SafeError(
          "Both Odoo reports are required. Upload Attendance and Pivot Worked Hours.",
        );
      if (attendance.size > 8 * 1024 * 1024 || pivot.size > 8 * 1024 * 1024)
        throw new SafeError("Each Odoo report must be under 8 MB.");
      const job = await createTimekeepingJob(
        {
          kind: "upload",
          attendance: {
            name: attendance.name,
            bytes: Buffer.from(await attendance.arrayBuffer()).toString(
              "base64",
            ),
          },
          pivot: {
            name: pivot.name,
            bytes: Buffer.from(await pivot.arrayBuffer()).toString("base64"),
          },
        },
        user,
      );
      if (job.status === "Queued") after(() => runTimekeepingJob(job.id, user));
      return Response.json({ job }, { status: 202 });
    }
    const text = await request.text();
    if (text.length > 64000) throw new SafeError("The request is too large.");
    const body = JSON.parse(text);
    if (body.action === "analyze") {
      const aliases = z
        .record(z.string().max(200), z.string().max(200))
        .safeParse(body.aliases || {});
      if (!aliases.success)
        throw new SafeError("Review the employee identity mappings.");
      const job = await createTimekeepingJob(
        {
          kind: "analyze",
          id: String(body.id),
          rules: body.rules,
          aliases: aliases.data,
        },
        user,
      );
      if (job.status === "Queued") after(() => runTimekeepingJob(job.id, user));
      return Response.json({ job }, { status: 202 });
    }
    if (body.action === "retry-job") {
      const job = await retryTimekeepingJob(String(body.id), user);
      after(() => runTimekeepingJob(job.id, user));
      return Response.json({ job }, { status: 202 });
    }
    if (body.action === "review")
      return Response.json({ batch: await reviewOdoo(body, user) });
    if (body.action === "rules") {
      const rules = odooRulesSchema.safeParse(body.rules);
      if (!rules.success) throw new SafeError("Check the attendance rules.");
      await transaction(async (tx) => {
        const previous = await readRecord(tx, "odoo_rules", user.email);
        await putRecord(tx, "odoo_rules", user.email, {
          rules: rules.data,
          aliases: {},
        });
        await audit(tx, user.email, "timekeeping.rules_updated", undefined, {
          previous,
          next: rules.data,
        });
      });
      return Response.json({ message: "Attendance rules saved." });
    }
    if (body.action === "export") {
      const batch = await getOdooBatch(String(body.id), user),
        csv = body.format === "csv";
      const output = await exportOdoo(batch, csv);
      await transaction((tx) =>
        audit(tx, user.email, "timekeeping.exported", undefined, {
          batchId: batch.id,
          format: csv ? "csv" : "xlsx",
          period: batch.period,
          recordCount: batch.records.length,
        }),
      );
      return new Response(new Uint8Array(output), {
        headers: {
          "Content-Type": csv
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="Daily-Joe-Careers-Attendance-${batch.period.start}-${batch.period.end}.${csv ? "csv" : "xlsx"}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    throw new SafeError("Choose a timekeeping action.");
  } catch (error) {
    if (!(error instanceof SafeError) || error.status >= 500)
      await reportIssue("timekeeping.failed");
    return safeError(error);
  }
}
