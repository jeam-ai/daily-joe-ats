import { after } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { bulkApplicants } from "@/lib/server/applicant-bulk";
import { deliverEmail } from "@/lib/server/email-outbox";
import { demoEnabled, SafeError } from "@/lib/server/config";
export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const demo = request.headers.get("x-djc-dataset") === "demo";
    if (demo && !demoEnabled())
      throw new SafeError("Demo data is unavailable.", 403);
    const result = await bulkApplicants(await request.json(), user, demo);
    if ("file" in result && result.file)
      return new Response(new Uint8Array(result.file), {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition":
            "attachment; filename=Daily-Joe-selected-applicants.xlsx",
          "Cache-Control": "no-store",
        },
      });
    if (result.emailIds.length)
      after(async () => {
        for (const id of result.emailIds)
          await deliverEmail(id, user).catch(() => undefined);
      });
    return Response.json(result);
  } catch (error) {
    return safeError(error);
  }
}
