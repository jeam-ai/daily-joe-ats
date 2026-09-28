import "server-only";
import type { Application } from "@/types";
import { INTAKE_QUEUE_LIMIT, eligibleIntake, isDemo } from "@/lib/data-policy";
import { retentionPolicyDefaults } from "@/lib/retention-policy";
import type { Transaction } from "./database";

const at = (time: number) => new Date(time).toISOString();
const protectedFromQueueRetention = (application: Application) =>
  application.status === "Hired" ||
  [
    "Initial Interview",
    "Final Interview",
    "Requirements",
    "Onboarding",
    "Hired",
  ].includes(application.stage);

/**
 * Starts the outside-live-queue grace clock at the same time the 500-item
 * window is balanced. This is deliberately separate from cleanup: it never
 * deletes data and it preserves an existing clock instead of resetting it.
 */
export async function syncOutsideQueueGraceDates(
  tx: Transaction,
  applications: Application[],
  nowMs = Date.now(),
) {
  const live = applications
    .filter(
      (application) => !isDemo(application) && eligibleIntake(application),
    )
    .sort(
      (a, b) =>
        Date.parse(b.appliedAt) - Date.parse(a.appliedAt) ||
        b.id.localeCompare(a.id),
    );
  const withinLiveQueue = new Set(
    live.slice(0, INTAKE_QUEUE_LIMIT).map((application) => application.id),
  );
  const outside = applications.filter(
    (application) =>
      !isDemo(application) &&
      !application.deletedAt &&
      eligibleIntake(application) &&
      !withinLiveQueue.has(application.id) &&
      !protectedFromQueueRetention(application),
  );
  const existing = await tx.query(
    "SELECT application_id FROM application_retention WHERE category='outside_live_queue'",
  );
  const existingIds = new Set(
    existing.map((row) => String(row.application_id)),
  );
  const outsideIds = new Set(outside.map((application) => application.id));
  const policyRows = await tx.query(
    "SELECT days FROM retention_policies WHERE name='application_queue_days'",
  );
  const configuredDays = Number(policyRows[0]?.days);
  const days =
    Number.isInteger(configuredDays) && configuredDays >= 1
      ? configuredDays
      : retentionPolicyDefaults.application_queue_days;
  const startedAt = at(nowMs);
  const expiresAt = at(nowMs + days * 86400000);
  const pending = outside.filter(
    (application) => !existingIds.has(application.id),
  );

  for (let offset = 0; offset < pending.length; offset += 200) {
    const batch = pending.slice(offset, offset + 200);
    let parameter = 0;
    const values = batch
      .map(
        () =>
          `($${++parameter},'outside_live_queue',$${++parameter},$${++parameter},$${++parameter})`,
      )
      .join(",");
    await tx.query(
      `INSERT INTO application_retention(application_id,category,started_at,expires_at,reason)
       VALUES ${values}
       ON CONFLICT(application_id) DO NOTHING`,
      batch.flatMap((application) => [
        application.id,
        startedAt,
        expiresAt,
        "Outside the newest 500 eligible applications",
      ]),
    );
  }
  for (const id of existingIds)
    if (!outsideIds.has(id))
      await tx.query(
        "DELETE FROM application_retention WHERE application_id=$1 AND category='outside_live_queue'",
        [id],
      );
  return {
    scheduled: pending.length,
    cancelled: [...existingIds].filter((id) => !outsideIds.has(id)).length,
  };
}
