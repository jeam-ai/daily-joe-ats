import { requireOrigin, requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { deleteApplicant, restoreApplicant } from "@/lib/server/applicants";
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
    if (demo && !demoEnabled()) throw new SafeError("Demo data is unavailable.", 403);
    const { id } = await params;
    const result = await readTransaction(async (tx) => {
      const state = await getState(tx);
      const application = state.applications.find(
        (item) => item.id === id && !item.deletedAt && !!item.isDemo === demo,
      );
      if (!application) return null;
      const rows = await tx.query(
        "SELECT category,started_at,expires_at,reason FROM application_retention WHERE application_id=$1",
        [id],
      );
      const retention = rows[0];
      if (retention) {
        application.retentionCategory = String(retention.category);
        application.retentionStartedAt = String(retention.started_at);
        application.retentionExpiresAt = String(retention.expires_at);
        application.retentionReason = String(retention.reason);
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
