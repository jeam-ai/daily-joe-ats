import { requireOrigin, requireUser } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { transaction } from "@/lib/server/database";
import { audit, getState, saveState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("HR manager access required.", 403);
    const { id } = await params;
    const body = await request.json();
    if (body.action !== "retain-talent-pool")
      throw new SafeError("Unsupported retention action.");

    const now = new Date().toISOString();
    await transaction(async (tx) => {
      const configured = await tx.query(
        "SELECT name,days FROM retention_policies WHERE name IN ('talent_pool_days','talent_pool_grace_days')",
      );
      const retentionDays = Number(
        configured.find((row) => row.name === "talent_pool_days")?.days || 30,
      );
      const graceDays = Number(
        configured.find((row) => row.name === "talent_pool_grace_days")?.days ||
          10,
      );
      const expires = new Date(
        Date.parse(now) + retentionDays * 86400000,
      ).toISOString();
      const grace = new Date(
        Date.parse(expires) + graceDays * 86400000,
      ).toISOString();
      const state = await getState(tx);
      const selected = state.applications.find(
        (application) => application.id === id && !application.deletedAt,
      );
      if (!selected || selected.status !== "Talent Pool" || selected.isDemo)
        throw new SafeError("Talent Pool applicant not found.", 404);

      // Membership belongs to the person, so reset all of their current
      // Talent Pool applications together rather than an arbitrary one.
      const related = state.applications.filter(
        (application) =>
          application.applicant.id === selected.applicant.id &&
          application.status === "Talent Pool" &&
          !application.deletedAt &&
          !application.isDemo,
      );
      for (const application of related) {
        application.talentPoolAddedAt = now;
        delete application.talentPoolExpiredAt;
      }
      selected.timeline.push({
        id: crypto.randomUUID(),
        timestamp: now,
        user: user.email,
        action: `Talent Pool retention reset for ${retentionDays} days`,
        applicationId: selected.id,
        metadata: { expiresAt: expires, graceExpiresAt: grace },
      });
      await tx.query(
        "DELETE FROM application_retention WHERE category='talent_pool' AND application_id IN (SELECT id FROM applications WHERE applicant_id=$1)",
        [selected.applicant.id],
      );
      await audit(tx, user.email, "talent_pool.retention_reset", selected.id, {
        applicantId: selected.applicant.id,
        expiresAt: expires,
        graceExpiresAt: grace,
      });
      await saveState(tx, state, { sync: false });
      // saveState upserts the normalized membership row. Use configured policy
      // values if HR has changed the defaults.
      await tx.query(
        "UPDATE talent_pool_memberships SET started_at=$1,expires_at=$2,grace_expires_at=$3,updated_by=$4 WHERE applicant_id=$5",
        [now, expires, grace, user.email, selected.applicant.id],
      );
    });
    return Response.json({ message: "Talent Pool retention reset." });
  } catch (error) {
    return safeError(error);
  }
}
