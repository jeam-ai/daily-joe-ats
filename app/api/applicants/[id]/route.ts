import { requireOrigin, requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import {
  deleteApplicant,
  restoreApplicant,
  updateApplicant,
} from "@/lib/server/applicants";
import { readTransaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { demoEnabled, SafeError } from "@/lib/server/config";
export const runtime = "nodejs";
export const maxDuration = 240;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const user = await requireUser();
    const demo = request.headers.get("x-djc-dataset") === "demo";
    if (demo && !demoEnabled())
      throw new SafeError("Demo data is unavailable.", 403);
    const { id } = await params;
    const result = await readTransaction(async (tx) => {
      const state = await getState(tx);
      const application = state.applications.find(
        (item) => item.id === id && !item.deletedAt && !!item.isDemo === demo,
      );
      if (!application) return null;
      delete application.retentionCategory;
      delete application.retentionStartedAt;
      delete application.retentionExpiresAt;
      delete application.retentionReason;
      delete application.talentPoolExpiresAt;
      delete application.talentPoolGraceExpiresAt;
      const rows = await tx.query(
        "SELECT r.category,r.started_at,r.expires_at,r.reason,tp.expires_at AS talent_pool_expires_at,tp.grace_expires_at AS talent_pool_grace_expires_at FROM applications a LEFT JOIN application_retention r ON r.application_id=a.id LEFT JOIN talent_pool_memberships tp ON tp.applicant_id=a.applicant_id WHERE a.id=$1",
        [id],
      );
      const retention = rows[0];
      if (retention?.category) {
        application.retentionCategory = String(retention.category);
        application.retentionStartedAt = String(retention.started_at);
        application.retentionExpiresAt = String(retention.expires_at);
        application.retentionReason = String(retention.reason);
      }
      if (
        retention?.talent_pool_expires_at &&
        application.status === "Talent Pool" &&
        !application.talentPoolExpiredAt
      ) {
        application.talentPoolExpiresAt = String(
          retention.talent_pool_expires_at,
        );
        application.talentPoolGraceExpiresAt = String(
          retention.talent_pool_grace_expires_at,
        );
      }
      return application;
    });
    if (!result) throw new SafeError("Applicant not found.", 404);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeError(error);
  }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const result = await deleteApplicant(id, await request.json(), user);
    return Response.json({
      ...result,
      syncStatus: result.isDemo
        ? "Demo isolated"
        : "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const application = await updateApplicant(id, await request.json(), user);
    return Response.json({
      application,
      syncStatus: application.isDemo
        ? "Demo isolated"
        : "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    if ((await request.json()).confirmed !== true)
      throw new SafeError("Confirm restoring this applicant.");
    const result = await restoreApplicant(id, user);
    return Response.json({
      ...result,
      syncStatus: "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}
