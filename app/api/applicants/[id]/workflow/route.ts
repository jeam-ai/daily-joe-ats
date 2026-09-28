import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { updateApplicantWorkflow } from "@/lib/server/applicants";
import { safeError } from "@/lib/server/response";

export const runtime = "nodejs";
export const maxDuration = 240;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const raw = await request.text();
    if (raw.length > 500000)
      throw new SafeError(
        "This applicant update is too large. Refresh and try again.",
      );
    const body = JSON.parse(raw);
    const application = await updateApplicantWorkflow(
      id,
      body,
      user,
      body.confirmed === true,
    );
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
