import "server-only";
import type { Application } from "@/types";
import { INTAKE_QUEUE_LIMIT, eligibleIntake, isDemo } from "@/lib/data-policy";
import {
  retentionPolicyDefaults,
  type RetentionPolicies,
  type RetentionPolicyName,
} from "@/lib/retention-policy";
import { timekeepingCutoffExpiresAt } from "@/lib/timekeeping-retention";
import { writeAudit } from "./audit";
import { getState, saveState } from "./repository";
import { transaction, type Transaction } from "./database";

const at = (time: number) => new Date(time).toISOString();
const plusDays = (time: number, days: number) => time + days * 86400000;
export const protectedApplication = (application: Application) =>
  application.status === "Hired" ||
  [
    "Initial Interview",
    "Final Interview",
    "Requirements",
    "Onboarding",
    "Hired",
  ].includes(application.stage);

export async function readRetentionPolicies(tx: Transaction) {
  const rows = await tx.query("SELECT name,days FROM retention_policies");
  const values: RetentionPolicies = { ...retentionPolicyDefaults };
  for (const row of rows) {
    const name = String(row.name) as RetentionPolicyName;
    const days = Number(row.days);
    if (
      Object.hasOwn(values, name) &&
      Number.isInteger(days) &&
      days >= 1 &&
      days <= 3650
    )
      values[name] = days;
  }
  return values;
}

async function policies(tx: Transaction) {
  const values = await readRetentionPolicies(tx);
  const now = new Date().toISOString();
  for (const [name, days] of Object.entries(retentionPolicyDefaults))
    await tx.query(
      "INSERT INTO retention_policies(name,days,updated_at) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING",
      [name, days, now],
    );
  return values;
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
    "gmail_thread_events",
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

async function cleanExpiredTimekeepingCutoffs(
  tx: Transaction,
  now: string,
  graceDays: number,
  dryRun: boolean,
) {
  const cutoffs = await tx.query(
    "SELECT id,payload FROM records WHERE collection='odoo_cutoffs'",
  );
  const expired = cutoffs.flatMap((row) => {
    const cutoff = String(row.id);
    const [, periodEnd] = cutoff.split(":");
    const expiresAt = periodEnd
      ? timekeepingCutoffExpiresAt(periodEnd, graceDays)
      : null;
    if (!expiresAt || expiresAt > now) return [];
    try {
      const batchId = JSON.parse(String(row.payload));
      return typeof batchId === "string" ? [{ cutoff, batchId }] : [];
    } catch {
      return [];
    }
  });
  if (dryRun) return expired.length;

  for (const { cutoff, batchId } of expired) {
    await tx.query(
      "DELETE FROM records WHERE collection='odoo_cutoffs' AND id=$1",
      [cutoff],
    );
    await tx.query(
      "DELETE FROM records WHERE collection IN ('odoo_batches','odoo_sources','odoo_index') AND id=$1",
      [batchId],
    );
    await tx.query(
      "DELETE FROM records WHERE collection='odoo_exceptions' AND id LIKE $1",
      [`${batchId}:%`],
    );
    await tx.query(
      "DELETE FROM records WHERE collection='odoo_reviews' AND payload LIKE $1",
      [`%\"batchId\":\"${batchId}\"%`],
    );
    await tx.query(
      "DELETE FROM records WHERE collection='odoo_fingerprints' AND payload=$1",
      [JSON.stringify(batchId)],
    );
    await tx.query(
      "DELETE FROM records WHERE collection='timekeeping_jobs' AND payload LIKE $1",
      [`%\"batchId\":\"${batchId}\"%`],
    );
    await tx.query(
      "DELETE FROM audit_logs WHERE action LIKE 'timekeeping.%' AND (payload LIKE $1 OR payload LIKE $2)",
      [`%${batchId}%`, `%${cutoff}%`],
    );
  }
  return expired.length;
}

/**
 * Preserve the reporting contribution without retaining applicant data. This
 * row deliberately has no application ID, name, contact data, resume text, or
 * free-form notes; it is safe to keep after the linked record is deleted.
 */
async function archiveAnonymousReportSnapshot(
  tx: Transaction,
  application: Application,
  reportDays: number,
  nowMs: number,
) {
  const applied = Date.parse(application.appliedAt);
  const snapshotDate = Number.isFinite(applied)
    ? new Date(applied).toISOString().slice(0, 10)
    : new Date(nowMs).toISOString().slice(0, 10);
  await tx.query(
    `INSERT INTO retention_report_snapshots(snapshot_date,stage,position,location,source,count,expires_at)
     VALUES($1,$2,$3,$4,$5,1,$6)
     ON CONFLICT(snapshot_date,stage,position,location,source,expires_at)
     DO UPDATE SET count=retention_report_snapshots.count+1`,
    [
      snapshotDate,
      application.stage,
      application.position,
      application.location,
      application.source || "Not recorded",
      at(plusDays(nowMs, reportDays)),
    ],
  );
}

/** Re-evaluates retention from current queue membership; safe to run repeatedly. */
export type RetentionRunOptions = {
  dryRun?: boolean;
  /**
   * Administrator-confirmed disposal of applicants already placed in the
   * durable retention queue. This bypasses only their grace date; it never
   * includes a live/protected applicant or a Talent Pool membership.
   */
  purgeQueuedApplications?: boolean;
};
export function retentionDryRunEnabled() {
  return (
    process.env.DRY_RUN_RETENTION_CLEANUP?.trim() !== "false" ||
    process.env.RETENTION_CLEANUP_VERIFIED?.trim() !== "true"
  );
}
export async function runRetentionCleanup(options: RetentionRunOptions = {}) {
  return transaction(async (tx) => {
    // A caller may demand a preview, but may never bypass the two deployment
    // safety switches by passing dryRun:false.
    const dryRun = retentionDryRunEnabled() || options.dryRun === true;
    const nowMs = Date.now();
    const now = at(nowMs);
    const policy = await policies(tx);
    const state = await getState(tx);
    const timekeepingCutoffs = await cleanExpiredTimekeepingCutoffs(
      tx,
      now,
      policy.timekeeping_cutoff_grace_days,
      dryRun,
    );
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
    const incomingMail = new Map(
      (
        await tx.query(
          "SELECT application_id,MAX(occurred_at) AS latest_at FROM gmail_thread_events WHERE direction='incoming' GROUP BY application_id",
        )
      ).map((row) => [
        String(row.application_id),
        Date.parse(String(row.latest_at)),
      ]),
    );
    const pendingRetention: string[][] = [];
    const scheduleRetention = (
      applicationId: string,
      category: string,
      startedAt: string,
      expiresAt: string,
      reason: string,
    ) => {
      const previous = existing.get(applicationId);
      if (
        previous?.category === category &&
        previous.started_at === startedAt &&
        previous.expires_at === expiresAt
      )
        return;
      pendingRetention.push([
        applicationId,
        category,
        startedAt,
        expiresAt,
        reason,
      ]);
    };

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
        scheduleRetention(
          application.id,
          "talent_pool",
          at(started),
          at(
            plusDays(
              started,
              policy.talent_pool_days + policy.talent_pool_grace_days,
            ),
          ),
          `Talent Pool ${policy.talent_pool_days}-day retention plus ${policy.talent_pool_grace_days}-day grace period`,
        );
        await tx.query(
          "UPDATE talent_pool_memberships SET expires_at=$1,grace_expires_at=$2 WHERE applicant_id=$3 AND started_at=$4",
          [
            at(plusDays(started, policy.talent_pool_days)),
            at(
              plusDays(
                started,
                policy.talent_pool_days + policy.talent_pool_grace_days,
              ),
            ),
            application.applicant.id,
            at(started),
          ],
        );
      } else if (terminal) {
        const lastActivity = Date.parse(
          application.lastActivity || application.appliedAt,
        );
        const started =
          application.status === "No Response"
            ? Math.max(lastActivity, incomingMail.get(application.id) || 0)
            : lastActivity;
        scheduleRetention(
          application.id,
          "terminal",
          at(started),
          at(plusDays(started, policy.terminal_application_days)),
          "Rejected, withdrawn, or no-response retention",
        );
      } else if (outsideQueue && !protectedApplication(application)) {
        // Preserve the original grace clock only while the record remains
        // outside the newest 500. Returning to the queue cancels it below.
        const existingStart =
          existingRecord?.category === "outside_live_queue"
            ? Date.parse(String(existingRecord.started_at))
            : NaN;
        const started = Math.max(
          Number.isFinite(existingStart) ? existingStart : nowMs,
          incomingMail.get(application.id) || 0,
        );
        scheduleRetention(
          application.id,
          "outside_live_queue",
          at(started),
          at(plusDays(started, policy.application_queue_days)),
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
    for (let offset = 0; offset < pendingRetention.length; offset += 100) {
      const batch = pendingRetention.slice(offset, offset + 100);
      await tx.query(
        `INSERT INTO application_retention(application_id,category,started_at,expires_at,reason) VALUES ${batch
          .map(
            (_, row) =>
              `(${Array.from({ length: 5 }, (_, col) => `$${row * 5 + col + 1}`).join(",")})`,
          )
          .join(",")}
         ON CONFLICT(application_id) DO UPDATE SET category=excluded.category,started_at=excluded.started_at,expires_at=excluded.expires_at,reason=excluded.reason`,
        batch.flat(),
      );
    }

    const refreshed = await tx.query(
      options.purgeQueuedApplications
        ? "SELECT application_id,category,expires_at FROM application_retention WHERE expires_at<=$1 OR category IN ('outside_live_queue','terminal')"
        : "SELECT application_id,category,expires_at FROM application_retention WHERE expires_at<=$1",
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
      // A forced queue cleanup only bypasses the grace date for applicant
      // deletion categories. Talent Pool expiry keeps its separate workflow.
      if (
        options.purgeQueuedApplications &&
        !["outside_live_queue", "terminal"].includes(category) &&
        String(row.expires_at) > now
      )
        continue;
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
      for (const application of deletedApplications) {
        await archiveAnonymousReportSnapshot(
          tx,
          application,
          policy.report_days,
          nowMs,
        );
        await deleteApplication(tx, application);
      }
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
        "INSERT INTO hiring_need_retention(hiring_need_id,started_at,expires_at,reason) VALUES($1,$2,$3,$4) ON CONFLICT(hiring_need_id) DO UPDATE SET started_at=excluded.started_at,expires_at=excluded.expires_at,reason=excluded.reason",
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
      const expiredSnapshots = await tx.query(
        "DELETE FROM retention_report_snapshots WHERE expires_at<=$1 RETURNING snapshot_date",
        [now],
      );
      await recordCleanupMetric(tx, "applications_deleted", remove.size, now);
      await recordCleanupMetric(
        tx,
        "anonymous_report_snapshots_expired",
        expiredSnapshots.length,
        now,
      );
      await recordCleanupMetric(
        tx,
        "talent_pool_expired",
        wouldExpireTalentPool,
        now,
      );
      await recordCleanupMetric(tx, "hiring_needs_expired", needIds.size, now);
      await recordCleanupMetric(
        tx,
        "timekeeping_cutoffs_deleted",
        timekeepingCutoffs,
        now,
      );
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
      archivedAnonymousReportSnapshots: dryRun ? 0 : deletedApplications.length,
      wouldDeleteTimekeepingCutoffs: timekeepingCutoffs,
      deletedTimekeepingCutoffs: dryRun ? 0 : timekeepingCutoffs,
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
