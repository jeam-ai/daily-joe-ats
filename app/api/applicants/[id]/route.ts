import { requireOrigin, requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { deleteApplicant, restoreApplicant } from "@/lib/server/applicants";
export const runtime = "nodejs";
export const maxDuration = 240;
type Context = { params: Promise<{ id: string }> };
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
        : "Changes committed to Google Sheets.",
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
      syncStatus: "Changes committed to Google Sheets.",
    });
  } catch (error) {
    return safeError(error);
  }
}
