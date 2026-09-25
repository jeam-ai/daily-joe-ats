import { requireOrigin, requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { createApplicant } from "@/lib/server/applicants";
import { transaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const text = await request.text();
    if (text.length > 16000)
      throw new SafeError("Applicant details are too long.");
    const result = await createApplicant(JSON.parse(text), user);
    return Response.json({
      ...result,
      syncStatus: "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}
export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    const records = await transaction(async (tx) =>
      (await getState(tx)).applications
        .filter((a) => a.deletedAt && !a.isDemo)
        .map((a) => ({
          id: a.id,
          name: a.applicant.name,
          position: a.position,
          deletedAt: a.deletedAt,
          deletedBy: a.deletedBy,
          reason: a.deletionReason,
        })),
    );
    return Response.json(
      { records },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return safeError(error);
  }
}
