import "server-only";
import { createHash } from "node:crypto";
import type { User } from "@/types";
import { seal, unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import {
  readTransaction,
  transaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { audit } from "./repository";
import {
  previewOdoo,
  analyzeOdooUpload,
  requireTimekeeping,
  odooRulesSchema,
} from "./odoo";
import { recordIssue, resolveIssue } from "./diagnostics";
import { withDeadline } from "./deadline";
// These transactions only coordinate attendance jobs and append their audit
// metadata; they never mutate the recruitment workspace. A separate lock keeps
// long recruitment updates from blocking job claims and progress writes.
const jobTransaction = <T>(fn: (tx: Transaction) => Promise<T>) =>
  transaction(fn, { lockKey: 812902 });
type Input =
  | {
      kind: "upload";
      attendance: { name: string; bytes: string };
      pivot: { name: string; bytes: string };
    }
  | {
      kind: "analyze";
      id: string;
      rules: unknown;
      aliases: Record<string, string>;
      cutoff?: { start: string; end: string };
    };
export type TimekeepingJob = {
  id: string;
  kind: Input["kind"];
  actor: string;
  status: "Queued" | "Running" | "Completed" | "Failed";
  progress: number;
  detail: string;
  createdAt: string;
  completedAt?: string;
  attempts: number;
  leaseUntil?: number;
  runId?: string;
  error?: string;
  result?: unknown;
};
export async function createTimekeepingJob(input: Input, user: User) {
  requireTimekeeping(user);
  if (
    input.kind === "analyze" &&
    !odooRulesSchema.safeParse(input.rules).success
  )
    throw new SafeError("Review the attendance rules before analysis.");
  const id = createHash("sha256")
    .update(user.email + JSON.stringify(input))
    .digest("hex");
  return jobTransaction(async (tx) => {
    const previous = await readRecord<TimekeepingJob>(
      tx,
      "timekeeping_jobs",
      id,
    );
    // Upload previews expire, so a later upload must be allowed to produce a new preview.
    if (
      previous &&
      !(
        previous.kind === "upload" &&
        previous.status === "Completed" &&
        Date.now() - Date.parse(previous.completedAt || previous.createdAt) >
          25 * 60000
      )
    )
      return previous;
    const job: TimekeepingJob = {
      id,
      kind: input.kind,
      actor: user.email,
      status: "Queued",
      progress: 0,
      detail:
        input.kind === "upload"
          ? "Waiting to read both reports"
          : "Waiting to analyze the full cutoff",
      createdAt: new Date().toISOString(),
      attempts: 0,
    };
    await putRecord(
      tx,
      "timekeeping_inputs",
      id,
      seal(input, config().encryptionKey),
    );
    await putRecord(tx, "timekeeping_jobs", id, job);
    await audit(tx, user.email, "timekeeping.job_queued", undefined, {
      jobId: id,
      kind: input.kind,
    });
    return job;
  });
}
export async function getTimekeepingJob(id: string, user: User) {
  requireTimekeeping(user);
  const snapshot = await readTransaction((tx) =>
    readRecord<TimekeepingJob>(tx, "timekeeping_jobs", id),
  );
  if (!snapshot || snapshot.actor !== user.email)
    throw new SafeError("Processing job not found for this user.", 404);
  // Progress polling must not contend with recruitment writes or worker claims.
  if (snapshot.status !== "Running" || (snapshot.leaseUntil || 0) >= Date.now())
    return snapshot;
  return jobTransaction(async (tx) => {
    const job = await readRecord<TimekeepingJob>(tx, "timekeeping_jobs", id);
    if (!job || job.actor !== user.email)
      throw new SafeError("Processing job not found for this user.", 404);
    if (job.status === "Running" && (job.leaseUntil || 0) < Date.now()) {
      job.status = "Failed";
      job.error =
        "Processing was interrupted. Retry the saved job; no attendance records were removed.";
      delete job.runId;
      await putRecord(tx, "timekeeping_jobs", id, job);
      await recordIssue("timekeeping.failed", { jobId: id }, tx);
      await audit(tx, user.email, "timekeeping.job_interrupted", undefined, {
        jobId: id,
      });
    }
    return job;
  });
}
export async function retryTimekeepingJob(id: string, user: User) {
  requireTimekeeping(user);
  return jobTransaction(async (tx) => {
    const job = await readRecord<TimekeepingJob>(tx, "timekeeping_jobs", id);
    if (!job || job.actor !== user.email)
      throw new SafeError("Processing job not found.", 404);
    if (job.status !== "Failed") return job;
    if (job.attempts >= 3)
      throw new SafeError(
        "This job failed three times. Review the Error Center and upload corrected reports.",
      );
    job.status = "Queued";
    job.progress = 0;
    delete job.error;
    await putRecord(tx, "timekeeping_jobs", id, job);
    await audit(tx, user.email, "timekeeping.job_retried", undefined, {
      jobId: id,
    });
    return job;
  });
}
export async function runTimekeepingJob(id: string, user: User) {
  requireTimekeeping(user);
  const claimed = await jobTransaction(async (tx) => {
    const job = await readRecord<TimekeepingJob>(tx, "timekeeping_jobs", id);
    if (!job || job.actor !== user.email || job.status !== "Queued")
      return null;
    const enc = await readRecord<string>(tx, "timekeeping_inputs", id);
    if (!enc)
      throw new SafeError(
        "Saved reports are unavailable. Upload both reports again.",
      );
    job.status = "Running";
    job.attempts++;
    job.runId = crypto.randomUUID();
    job.leaseUntil = Date.now() + 150000;
    job.progress = 5;
    job.detail =
      job.kind === "upload"
        ? "Reading Attendance and Pivot Worked Hours"
        : "Preparing employee and date groups";
    await putRecord(tx, "timekeeping_jobs", id, job);
    return { job, input: unseal<Input>(enc, config().encryptionKey) };
  });
  if (!claimed) return;
  const { job, input } = claimed;
  const progress = async (processed: number, total: number) => {
    job.progress = total
      ? Math.min(95, 10 + Math.floor((processed / total) * 85))
      : 10;
    job.detail = `Processed ${processed.toLocaleString()} of ${total.toLocaleString()} employee-days`;
    await jobTransaction(async (tx) => {
      const current = await readRecord<TimekeepingJob>(
        tx,
        "timekeeping_jobs",
        id,
      );
      if (
        !current ||
        current.runId !== job.runId ||
        current.status !== "Running"
      )
        throw new SafeError("Processing stopped. Check the saved job status.");
      await putRecord(tx, "timekeeping_jobs", id, job);
    });
  };
  try {
    const result = await withDeadline<{ id: string }>(
      input.kind === "upload"
        ? previewOdoo(
            {
              name: input.attendance.name,
              bytes: Buffer.from(input.attendance.bytes, "base64"),
            },
            {
              name: input.pivot.name,
              bytes: Buffer.from(input.pivot.bytes, "base64"),
            },
            user,
          )
        : analyzeOdooUpload(
            input.id,
            input.rules,
            input.aliases,
            user,
            progress,
            input.cutoff,
          ),
      120000,
    );
    job.status = "Completed";
    job.progress = 100;
    job.detail =
      input.kind === "upload"
        ? "Both reports are ready for review"
        : "All employee-days analyzed";
    job.completedAt = new Date().toISOString();
    job.result = input.kind === "upload" ? result : { batchId: result.id };
    delete job.leaseUntil;
    await jobTransaction(async (tx) => {
      const current = await readRecord<TimekeepingJob>(
        tx,
        "timekeeping_jobs",
        id,
      );
      if (current?.runId !== job.runId) return;
      await putRecord(tx, "timekeeping_jobs", id, job);
      if (input.kind === "upload")
        await tx.query(
          "DELETE FROM records WHERE collection='timekeeping_inputs' AND id=$1",
          [id],
        );
      await audit(tx, user.email, "timekeeping.job_completed", undefined, {
        jobId: id,
        kind: job.kind,
      });
    });
    await resolveIssue("timekeeping.failed", { jobId: id }).catch(
      () => undefined,
    );
  } catch (e) {
    job.status = "Failed";
    job.error =
      e instanceof SafeError
        ? e.message
        : "Timekeeping could not finish processing these reports. Retry, or review the original exports.";
    delete job.leaseUntil;
    await jobTransaction(async (tx) => {
      const current = await readRecord<TimekeepingJob>(
        tx,
        "timekeeping_jobs",
        id,
      );
      if (current?.runId !== job.runId) return;
      await putRecord(tx, "timekeeping_jobs", id, job);
      await recordIssue("timekeeping.failed", { jobId: id }, tx);
      await audit(tx, user.email, "timekeeping.job_failed", undefined, {
        jobId: id,
      });
    });
  }
}
