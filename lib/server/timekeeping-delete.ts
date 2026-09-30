import "server-only";
import { z } from "zod";
import type { User } from "@/types";
import { unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import {
  transaction,
  readRecord,
  postgresConfigured,
  type Transaction,
} from "./database";
import { audit, getState, saveState } from "./repository";
import { requireTimekeeping, type OdooBatch } from "./odoo";
import type { TimekeepingJob } from "./timekeeping-jobs";

async function removeIds(
  tx: Transaction,
  table: "records" | "audit_logs",
  ids: string[],
  collection?: string,
) {
  for (let offset = 0; offset < ids.length; offset += 200) {
    const values: unknown[] = collection ? [collection] : [];
    const placeholders = ids.slice(offset, offset + 200).map((id) => {
      values.push(id);
      return `$${values.length}`;
    });
    await tx.query(
      `DELETE FROM ${table} WHERE ${collection ? "collection=$1 AND " : ""}id IN (${placeholders.join(",")})`,
      values,
    );
  }
}

export async function deleteOdooCutoff(input: unknown, user: User) {
  requireTimekeeping(user);
  const parsed = z
    .object({
      id: z.string().min(1),
      revision: z.number().int().positive(),
      confirmed: z.literal(true),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Confirm permanent deletion of this saved cutoff.");
  const body = parsed.data;
  return transaction(async (tx) => {
    // Serialize both workspace changes and attendance jobs/reviews. A running
    // analysis cannot recreate the cutoff immediately after its deletion.
    if (postgresConfigured())
      await tx.query("SELECT pg_advisory_xact_lock($1)", [812902]);
    const encrypted = await readRecord<string>(tx, "odoo_batches", body.id);
    if (!encrypted) throw new SafeError("Analysis not found.", 404);
    const batch = unseal<OdooBatch>(encrypted, config().encryptionKey);
    if (batch.revision !== body.revision)
      throw new SafeError(
        "This cutoff changed. Reload it before deleting.",
        409,
      );
    const cutoff = `${batch.period.start}:${batch.period.end}`;
    const logRows = await tx.query(
      "SELECT id,payload FROM audit_logs WHERE action LIKE 'timekeeping.%'",
    );
    const logs = logRows.map((row) => ({
      id: String(row.id),
      value: JSON.parse(String(row.payload)),
    }));
    const batchIds = new Set([
      batch.id,
      ...(batch.previousBatchId ? [batch.previousBatchId] : []),
    ]);
    for (const { value } of logs)
      if (value.cutoff === cutoff) {
        if (typeof value.id === "string") batchIds.add(value.id);
        if (typeof value.replacedBatchId === "string")
          batchIds.add(value.replacedBatchId);
      }
    const jobRows = await tx.query(
      "SELECT id,payload FROM records WHERE collection='timekeeping_jobs'",
    );
    const jobIds = new Set<string>();
    const previewIds = new Set<string>();
    for (const row of jobRows) {
      const job = JSON.parse(String(row.payload)) as TimekeepingJob;
      const result = job.result as
        { batchId?: string; id?: string } | undefined;
      if (job.kind !== "analyze") continue;
      const storedInput = await readRecord<string>(
        tx,
        "timekeeping_inputs",
        job.id,
      );
      const data = storedInput
        ? unseal<{ id: string; cutoff?: OdooBatch["period"] }>(
            storedInput,
            config().encryptionKey,
          )
        : null;
      let period = data?.cutoff;
      if (data && !period) {
        const preview = await readRecord<string>(tx, "odoo_uploads", data.id);
        if (preview)
          period = unseal<{ reports: { period: OdooBatch["period"] } }>(
            preview,
            config().encryptionKey,
          ).reports.period;
      }
      const sameCutoff =
        period?.start === batch.period.start &&
        period?.end === batch.period.end;
      if (sameCutoff && (job.status === "Queued" || job.status === "Running"))
        throw new SafeError(
          "Wait for this cutoff’s processing to finish before deleting it.",
          409,
        );
      if ((result?.batchId && batchIds.has(result.batchId)) || sameCutoff) {
        jobIds.add(job.id);
        if (data) previewIds.add(data.id);
      }
    }
    // Upload jobs can still carry a preview for a failed analysis of this cutoff.
    for (const row of jobRows) {
      const job = JSON.parse(String(row.payload)) as TimekeepingJob;
      const result = job.result as
        { id?: string; period?: OdooBatch["period"] } | undefined;
      if (
        job.kind === "upload" &&
        (previewIds.has(result?.id || "") ||
          (job.status === "Completed" &&
            result?.period?.start === batch.period.start &&
            result.period.end === batch.period.end))
      ) {
        jobIds.add(job.id);
        if (result?.id) previewIds.add(result.id);
      }
    }
    for (const collection of ["odoo_batches", "odoo_sources", "odoo_index"])
      await removeIds(tx, "records", [...batchIds], collection);
    const pointer = await readRecord<string>(tx, "odoo_cutoffs", cutoff);
    if (pointer && batchIds.has(pointer))
      await removeIds(tx, "records", [cutoff], "odoo_cutoffs");
    // Delete in the database instead of downloading every cutoff's exception
    // and review payload. Escape LIKE metacharacters to match only this ID.
    for (const id of batchIds) {
      const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
      await tx.query(
        "DELETE FROM records WHERE collection='odoo_exceptions' AND id LIKE $1 ESCAPE '\\'",
        [escapeLike(id) + ":%"],
      );
      await tx.query(
        "DELETE FROM records WHERE collection='odoo_reviews' AND payload LIKE $1 ESCAPE '\\'",
        ["%" + escapeLike('"batchId":' + JSON.stringify(id)) + "%"],
      );
      await tx.query(
        "DELETE FROM records WHERE collection='odoo_fingerprints' AND payload=$1",
        [JSON.stringify(id)],
      );
    }
    for (const collection of ["timekeeping_jobs", "timekeeping_inputs"])
      await removeIds(tx, "records", [...jobIds], collection);
    await removeIds(tx, "records", [...previewIds], "odoo_uploads");
    await removeIds(
      tx,
      "audit_logs",
      logs
        .filter(
          ({ value }) =>
            value.cutoff === cutoff ||
            batchIds.has(value.batchId) ||
            batchIds.has(value.id) ||
            jobIds.has(value.id) ||
            jobIds.has(value.jobId),
        )
        .map(({ id }) => id),
    );
    const state = await getState(tx);
    state.notifications = state.notifications.filter(
      (notification) =>
        ![...batchIds].some((id) => notification.id === `timekeeping-${id}`),
    );
    await saveState(tx, state, { sync: false });
    // Keep a minimal deletion receipt, without attendance, employee or review data.
    await audit(tx, user.email, "timekeeping.cutoff_deleted", undefined, {
      cutoff,
      deletedAnalysisCount: batchIds.size,
    });
    return { deleted: batch.id };
  });
}
