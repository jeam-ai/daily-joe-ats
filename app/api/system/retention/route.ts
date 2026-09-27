import { requireOrigin, requireUser } from "@/lib/auth/session";
import {
  aivenConfigured,
  postgresConfigured,
  readTransaction,
  transaction,
  type Transaction,
} from "@/lib/server/database";
import { audit, getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import {
  readRetentionPolicies,
  retentionDryRunEnabled,
  runRetentionCleanup,
} from "@/lib/server/retention";
import {
  retentionPolicyDefaults,
  type RetentionPolicies,
  type RetentionPolicyName,
} from "@/lib/retention-policy";

export const runtime = "nodejs";

async function count(tx: Transaction, sql: string, values: unknown[] = []) {
  const rows = await tx.query(sql, values);
  return Number(rows[0]?.count || 0);
}

export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    const result = await readTransaction(async (tx) => {
      const state = await getState(tx);
      const policies = await readRetentionPolicies(tx);
      const now = Date.now();
      const week = new Date(now + 7 * 86400000).toISOString();
      const activityCutoff = new Date(
        now - policies.activity_log_days * 86400000,
      ).toISOString();
      const pending = await tx.query(
        "SELECT category,COUNT(*) AS count FROM application_retention GROUP BY category",
      );
      const pendingByType = Object.fromEntries(
        pending.map((row) => [String(row.category), Number(row.count)]),
      ) as Record<string, number>;
      const expiredNeeds = await count(
        tx,
        "SELECT COUNT(*) AS count FROM hiring_need_retention",
      );
      const activityPending = await count(
        tx,
        "SELECT COUNT(*) AS count FROM audit_logs WHERE occurred_at<$1",
        [activityCutoff],
      );
      const connectionLimit = aivenConfigured()
        ? String(
            (
              await tx.query("SELECT current_setting('max_connections') AS n")
            )[0]?.n || "",
          )
        : "";
      const storage = postgresConfigured()
        ? Number(
            (
              await tx.query(
                "SELECT pg_database_size(current_database()) AS bytes",
              )
            )[0]?.bytes || 0,
          )
        : null;
      const configuredLimit = Number(process.env.DB_STORAGE_LIMIT_BYTES || 0);
      // Aiven's observed 20-connection default identifies its Free tier;
      // use its documented 1 GiB allocation as a conservative fallback.
      const limit =
        configuredLimit || (connectionLimit === "20" ? 1024 ** 3 : null);
      const percentage = storage !== null && limit ? storage / limit : null;
      const metrics = await tx.query(
        "SELECT month,metric,count FROM retention_cleanup_metrics WHERE month >= $1 ORDER BY month DESC,metric",
        [`${new Date().getUTCFullYear()}-01`],
      );
      const applications = state.applications.filter(
        (a) => !a.isDemo && !a.deletedAt,
      );
      const talentPool = applications.filter((a) => a.status === "Talent Pool");
      const poolDays = policies.talent_pool_days;
      const talentExpiring = talentPool.filter((a) => {
        const start = Date.parse(a.talentPoolAddedAt || a.appliedAt);
        return (
          !a.talentPoolExpiredAt &&
          start + poolDays * 86400000 <= now + 7 * 86400000
        );
      }).length;
      const hiringSoon = state.hiringNeeds.filter((need) => {
        const target = Date.parse(need.targetDate);
        return (
          need.status !== "Closed" &&
          Number.isFinite(target) &&
          target > now &&
          target <= now + 7 * 86400000
        );
      }).length;
      const reportCount = await count(
        tx,
        "SELECT COUNT(*) AS count FROM records WHERE collection LIKE 'report%'",
      );
      const timekeepingCount = await count(
        tx,
        "SELECT COUNT(*) AS count FROM records WHERE collection='odoo_cutoffs'",
      );
      return {
        dryRun: retentionDryRunEnabled(),
        policies,
        queue: {
          active: applications.filter((a) => a.queueState === "Active").length,
          queued: applications.filter((a) => a.queueState === "Queued").length,
          retentionPending: pendingByType.outside_live_queue || 0,
          rejectedOrWithdrawnPending: pendingByType.terminal || 0,
        },
        talentPoolExpiring: talentExpiring,
        hiringNeedsExpiring: hiringSoon,
        expiredHiringNeedsPending: expiredNeeds,
        activityRecordsPending: activityPending,
        reportCount,
        timekeepingCutoffCount: timekeepingCount,
        storageBytes: storage,
        storageLimitBytes: limit,
        storagePercent:
          percentage === null ? null : Math.round(percentage * 100),
        storageLevel:
          percentage === null
            ? "unconfigured"
            : percentage >= 0.9
              ? "critical"
              : percentage >= 0.8
                ? "review"
                : percentage >= 0.7
                  ? "warning"
                  : percentage >= 0.6
                    ? "monitor"
                    : "healthy",
        metrics,
      };
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    const body = await request.json();
    const input = body?.policies;
    const names = Object.keys(retentionPolicyDefaults) as RetentionPolicyName[];
    if (
      body?.action !== "update-policies" ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== names.length ||
      !names.every(
        (name) =>
          typeof input[name] === "number" &&
          Number.isInteger(input[name]) &&
          input[name] >= 1 &&
          input[name] <= 3650,
      )
    )
      throw new SafeError("Enter every retention period as 1–3650 whole days.");
    const requested = Object.fromEntries(
      names.map((name) => [name, input[name]]),
    ) as RetentionPolicies;
    const result = await transaction(async (tx) => {
      const previous = await readRetentionPolicies(tx);
      const changes = names
        .filter((name) => requested[name] !== previous[name])
        .map((name) => ({
          name,
          from: previous[name],
          to: requested[name],
        }));
      if (
        !retentionDryRunEnabled() &&
        changes.some((change) => change.to < change.from) &&
        body.confirmShorterRetention !== true
      )
        throw new SafeError(
          "Confirm shorter retention before making existing records eligible for cleanup.",
          409,
        );
      const now = new Date().toISOString();
      for (const change of changes)
        await tx.query(
          "INSERT INTO retention_policies(name,days,updated_at) VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET days=excluded.days,updated_at=excluded.updated_at",
          [change.name, change.to, now],
        );
      if (changes.length)
        await audit(tx, user.email, "retention.policies_updated", undefined, {
          changes,
        });
      return { policies: requested, changed: changes.length > 0 };
    });
    // An admin policy edit is rare. Recalculate warnings immediately in safe
    // preview mode; this can never permanently remove a record.
    const preview = await runRetentionCleanup({ dryRun: true });
    return Response.json({
      ...result,
      dryRun: retentionDryRunEnabled(),
      preview,
    });
  } catch (error) {
    return safeError(error);
  }
}
