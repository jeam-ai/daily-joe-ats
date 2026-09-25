import { requireUser } from "@/lib/auth/session";
import { readTransaction, type Transaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { retentionDryRunEnabled } from "@/lib/server/retention";

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
      const now = Date.now();
      const week = new Date(now + 7 * 86400000).toISOString();
      const activityCutoff = new Date(now - 30 * 86400000).toISOString();
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
      const connectionLimit =
        process.env.DATABASE_URL &&
        process.env.DATABASE_URL.includes(".aivencloud.com")
          ? String(
              (
                await tx.query("SELECT current_setting('max_connections') AS n")
              )[0]?.n || "",
            )
          : "";
      const storage =
        process.env.DATABASE_URL &&
        process.env.PERSISTENCE_PROVIDER !== "local" &&
        process.env.PERSISTENCE_PROVIDER !== "sheets"
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
      const retentionPolicies = await tx.query(
        "SELECT name,days FROM retention_policies WHERE name IN ('talent_pool_days','talent_pool_grace_days')",
      );
      const poolDays = Number(
        retentionPolicies.find((row) => row.name === "talent_pool_days")
          ?.days || 30,
      );
      const graceDays = Number(
        retentionPolicies.find((row) => row.name === "talent_pool_grace_days")
          ?.days || 10,
      );
      const talentExpiring = talentPool.filter((a) => {
        const start = Date.parse(a.talentPoolAddedAt || a.appliedAt);
        return (
          !a.talentPoolExpiredAt &&
          start + (poolDays + graceDays) * 86400000 <=
            now + graceDays * 86400000
        );
      }).length;
      const hiringSoon = state.hiringNeeds.filter((need) => {
        const target = Date.parse(need.targetDate);
        return (
          need.status !== "Closed" &&
          Number.isFinite(target) &&
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
