import { z } from "zod";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import {
  previewApplicantReprocessing,
  applyApplicantReprocessing,
} from "@/lib/server/applicant-reprocessing";
export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (request.headers.get("x-djc-dataset") === "demo")
      throw new SafeError("Exit Demo to reprocess imported applicants.", 403);
    const body = await request.json();
    if (body.action === "preview")
      return Response.json(
        await previewApplicantReprocessing(
          z.array(z.string()).min(1).max(10000).parse(body.ids),
          user,
        ),
      );
    if (body.action === "apply" && body.confirmed === true)
      return Response.json(
        await applyApplicantReprocessing(
          z.string().parse(body.id),
          z.array(z.string()).min(1).max(100000).parse(body.selected),
          body.overwriteProtected === true,
          user,
        ),
      );
    throw new SafeError("Preview applicant corrections before applying them.");
  } catch (error) {
    return safeError(error);
  }
}
