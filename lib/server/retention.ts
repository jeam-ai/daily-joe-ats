import "server-only";
import type { Application } from "@/types";
import { INTAKE_QUEUE_LIMIT, eligibleIntake, isDemo } from "@/lib/data-policy";
import { writeAudit } from "./audit";
import { getState, saveState } from "./repository";
import { transaction, type Transaction } from "./database";

type PolicyName =
  | "application_queue_days"
  | "terminal_application_days"
  | "talent_pool_days"
  | "talent_pool_grace_days"
  | "hiring_need_days"
  | "report_days"
  | "activity_log_days";

const defaults: Record<PolicyName, number> = {
  application_queue_days: 10,
  terminal_application_days: 10,
  talent_pool_days: 30,
  talent_pool_grace_days: 10,
  hiring_need_days: 10,
  report_days: 365,
  activity_log_days: 30,
};

const at = (time: number) => new Date(time).toISOString();
const plusDays = (time: number, days: number) => time + days * 86400000;
const protectedApplication = (application: Application) =>
  application.status === "Hired" ||
  [
    "Initial Interview",
    "Final Interview",
    "Requirements",
    "Onboarding",
    "Hired",
  ].includes(application.stage);

async function policies(tx: Transaction) {
  const rows = await tx.query("SELECT name,days FROM retention_policies");
  const values = { ...defaults };
  for (const row of rows) {
    const name = String(row.name) as PolicyName;
    const days = Number(row.days);
    if (name in values && Number.isInteger(days) && days >= 1 && days <= 3650)
      values[name] = days;
  }
  const now = new Date().toISOString();
  for (const [name, days] of Object.entries(defaults))
    await tx.query(
      "INSERT INTO retention_policies(name,days,updated_at) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING",
      [name, days, now],
    );
  return values;
}

async function putRetention(
  tx: Transaction,
  applicationId: string,
  category: string,
  startedAt: string,
  expiresAt: string,
  reason: string,
) {
  await tx.query(
    "INSERT INTO application_retention(application_id,category,started_at,expires_at,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id) DO UPDATE SET category=excluded.category,started_at=excluded.started_at,expires_at=excluded.expires_at,reason=excluded.reason",
    [applicationId, category, startedAt, expiresAt, reason],
  );
}

async function deleteApplication(tx: Transaction, application: Application) {
  const source = await tx.query(
    "SELECT resume_id,applicant_id FROM applications WHERE id=$1",
    [application.id],
  );
  const resumeId = source[0]?.resume_id
    ? String(source[0].resume_id)
    : undefined;
  const applicantId = source[0]?.applicant_id
    ? String(source[0].applicant_id)
    : undefined;
  for (const table of [
    "application_retention",
    "application_events",
    "application_requirements",
    "interviews",
    "screening_results",
    "employment_records",
    "intake_window",
  ])
    await tx.query(`DELETE FROM ${table} WHERE application_id=$1`, [
      application.id,
    ]);
  await tx.query(
    "DELETE FROM records WHERE id=$1 AND collection IN ('application_sources','ai_assist','extraction_jobs','email_outbox')",
    [application.id],
  );
  await tx.query("DELETE FROM applications WHERE id=$1", [application.id]);
  if (resumeId) {
    await tx.query(
      "DELETE FROM resume_sources WHERE resume_id=$1 AND NOT EXISTS (SELECT 1 FROM applications WHERE resume_id=$1)",
      [resumeId],
    );
    await tx.query(
      "DELETE FROM resumes WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM applications WHERE resume_id=$1)",
      [resumeId],
    );
  }
  if (applicantId)
    await tx.query(
      "DELETE FROM applicants WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM applications WHERE applicant_id=$1)",
      [applicantId],
    );
}

/** Re-evaluates retention from current queue membership; safe to run repeatedly. */
export type RetentionRunOptions = { dryRun?: boolean };
export function retentionDryRunEnabled() {
  return (
    process.env.DRY_RUN_RETENTION_CLEANUP !== "false" ||
    process.env.RETENTION_CLEANUP_VERIFIED !== "true"
  );
}
export async function runRetentionCleanup(options: RetentionRunOptions = {}) {
  return transaction(async (tx) => {
    const dryRun = options.dryRun ?? retentionDryRunEnabled();
    const nowMs = Date.now();
    const now = at(nowMs);
    const policy = await policies(tx);
    const state = await getState(tx);
    const originalApplications = [...state.applications];
    const live = state.applications
      .filter((a) => !isDemo(a) && !a.deletedAt && eligibleIntake(a))
      .sort(
        (a, b) =>
          Date.parse(b.appliedAt) - Date.parse(a.appliedAt) ||
          b.id.localeCompare(a.id),
      );
    const withinLiveQueue = new Set(
      live.slice(0, INTAKE_QUEUE_LIMIT).map((a) => a.id),
    );
    const records = await tx.query(
      "SELECT application_id,category,started_at,expires_at FROM application_retention",
    );
    const existing = new Map(records.map((r) => [String(r.application_id), r]));

    for (const application of state.applications) {
      if (isDemo(application) || application.deletedAt) continue;
      const existingRecord = existing.get(application.id);
      const terminal = ["Rejected", "Withdrawn", "No Response"].includes(
        application.status,
      );
      const outsideQueue =
        eligibleIntake(application) && !withinLiveQueue.has(application.id);
      if (application.status === "Talent Pool") {
        if (application.talentPoolExpiredAt) {
          if (existingRecord?.category === "talent_pool")
            await tx.query(
              "DELETE FROM application_retention WHERE application_id=$1",
              [application.id],
            );
          continue;
        }
        const started = Date.parse(
          application.talentPoolAddedAt || application.appliedAt,
        );
        await putRetention(
          tx,
          application.id,
          "talent_pool",
          at(started),
          at(
            plusDays(
              started,
              policy.talent_pool_days + policy.talent_pool_grace_days,
            ),
          ),
          "Talent Pool 30-day retention plus grace period",
        );
      } else if (terminal) {
        const started = Date.parse(
          application.lastActivity || application.appliedAt,
        );
        await putRetention(
          tx,
          application.id,
          "terminal",
          at(started),
          at(plusDays(started, policy.terminal_application_days)),
          "Rejected, withdrawn, or no-response retention",
        );
      } else if (outsideQueue && !protectedApplication(application)) {
        // Preserve the original grace clock only while the record remains
        // outside the newest 500. Returning to the queue cancels it below.
        await putRetention(
          tx,
          application.id,
          "outside_live_queue",
          existingRecord?.category === "outside_live_queue"
            ? String(existingRecord.started_at)
            : now,
          existingRecord?.category === "outside_live_queue"
            ? String(existingRecord.expires_at)
            : at(plusDays(nowMs, policy.application_queue_days)),
          "Outside the newest 500 eligible applications",
        );
      } else if (existingRecord) {
        await tx.query(
          "DELETE FROM application_retention WHERE application_id=$1",
          [application.id],
        );
        if (existingRecord.category === "outside_live_queue")
          await writeAudit(
            tx,
            "System",
            "retention.cancelled",
            application.id,
            {
              reason:
                "Application returned to the live queue or became protected",
            },
          );
      }
    }

    const refreshed = await tx.query(
      "SELECT application_id,category,expires_at FROM application_retention WHERE expires_at<=$1",
      [now],
    );
    const remove = new Set<string>();
    let wouldExpireTalentPool = 0;
    let talentPoolChanged = false;
    for (const row of refreshed) {
      const application = state.applications.find(
        (a) => a.id === String(row.application_id),
      );
      if (!application || application.deletedAt || isDemo(application))
        continue;
      const category = String(row.category);
      // Queue status is checked a second time immediately before deletion.
      if (
        category === "outside_live_queue" &&
        (!eligibleIntake(application) ||
          withinLiveQueue.has(application.id) ||
          protectedApplication(application))
      ) {
        await tx.query(
          "DELETE FROM application_retention WHERE application_id=$1",
          [application.id],
        );
        continue;
      }
      if (category === "talent_pool") {
        // Talent-pool expiry removes membership, not the applicant's wider
        // history. The profile stays available outside the pool.
        wouldExpireTalentPool++;
        if (!dryRun) {
          application.talentPoolExpiredAt = now;
          talentPoolChanged = true;
          await tx.query(
            "DELETE FROM application_retention WHERE application_id=$1",
            [application.id],
          );
          await writeAudit(
            tx,
            "System",
            "talent_pool.expired",
            application.id,
            {},
          );
        }
        continue;
      }
      remove.add(application.id);
    }
    const deletedApplications = originalApplications.filter((a) =>
      remove.has(a.id),
    );
    if (remove.size && !dryRun) {
      for (const application of state.applications.filter((a) =>
        remove.has(a.id),
      ))
        await writeAudit(
          tx,
          "System",
          "application.retention_deleted",
          application.id,
          {
            reason: "Configured retention period elapsed",
          },
        );
      state.applications = state.applications.filter((a) => !remove.has(a.id));
    }
    // The read model is committed before its now-unreferenced relational rows
    // are removed. The transaction keeps this atomic for readers.
    if (!dryRun && (remove.size || talentPoolChanged)) {
      await saveState(tx, state, { sync: false });
      for (const application of deletedApplications)
        await deleteApplication(tx, application);
    }

    // A hiring need has its own lifecycle. Expiry never deletes an applicant;
    // any linked applications are first unassigned and remain reviewable.
    for (const need of state.hiringNeeds) {
      const due = Date.parse(need.targetDate);
      if (!Number.isFinite(due) || due > nowMs) {
        await tx.query(
          "DELETE FROM hiring_need_retention WHERE hiring_need_id=$1",
          [need.id],
        );
        continue;
      }
      const expiresAt = at(plusDays(due, policy.hiring_need_days));
      await tx.query(
        "INSERT INTO hiring_need_retention(hiring_need_id,started_at,expires_at,reason) VALUES($1,$2,$3,$4) ON CONFLICT(hiring_need_id) DO NOTHING",
        [
          need.id,
          at(due),
          expiresAt,
          "Target date reached; HR may extend or reopen during grace period",
        ],
      );
    }
    const expiredNeeds = await tx.query(
      "SELECT hiring_need_id FROM hiring_need_retention WHERE expires_at<=$1",
      [now],
    );
    const needIds = new Set(expiredNeeds.map((r) => String(r.hiring_need_id)));
    if (needIds.size && !dryRun) {
      for (const application of state.applications)
        if (application.hiringNeedId && needIds.has(application.hiringNeedId))
          delete application.hiringNeedId;
      state.hiringNeeds = state.hiringNeeds.filter(
        (need) => !needIds.has(need.id),
      );
      await saveState(tx, state, { sync: false });
      for (const id of needIds) {
        await tx.query(
          "DELETE FROM hiring_need_retention WHERE hiring_need_id=$1",
          [id],
        );
        await tx.query("DELETE FROM hiring_needs WHERE id=$1", [id]);
        await writeAudit(
          tx,
          "System",
          "hiring_need.retention_deleted",
          undefined,
          { id },
        );
      }
    }
    const staleActivity = await tx.query(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE occurred_at<$1",
      [at(plusDays(nowMs, -policy.activity_log_days))],
    );
    const activityCount = Number(staleActivity[0]?.count || 0);
    if (!dryRun && activityCount) {
      const result = await tx.query(
        "DELETE FROM audit_logs WHERE occurred_at<$1 RETURNING id",
        [at(plusDays(nowMs, -policy.activity_log_days))],
      );
      await recordCleanupMetric(
        tx,
        "activity_logs_cleaned",
        result.length,
        now,
      );
    }
    if (!dryRun) {
      await recordCleanupMetric(tx, "applications_deleted", remove.size, now);
      await recordCleanupMetric(
        tx,
        "talent_pool_expired",
        wouldExpireTalentPool,
        now,
      );
      await recordCleanupMetric(tx, "hiring_needs_expired", needIds.size, now);
    }
    return {
      dryRun,
      wouldDeleteApplications: remove.size,
      wouldExpireTalentPool,
      wouldDeleteHiringNeeds: needIds.size,
      wouldCleanActivityLogs: activityCount,
      deletedApplications: dryRun ? 0 : remove.size,
      deletedTalentPoolMemberships: dryRun ? 0 : wouldExpireTalentPool,
      deletedHiringNeeds: dryRun ? 0 : needIds.size,
      liveQueue: Math.min(live.length, INTAKE_QUEUE_LIMIT),
    };
  });
}

async function recordCleanupMetric(
  tx: Transaction,
  metric: string,
  count: number,
  now: string,
) {
  if (!count) return;
  const month = now.slice(0, 7);
  await tx.query(
    "INSERT INTO retention_cleanup_metrics(month,metric,count,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(month,metric) DO UPDATE SET count=retention_cleanup_metrics.count+excluded.count,updated_at=excluded.updated_at",
    [month, metric, count, now],
  );
}
