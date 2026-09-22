import { reportIssue } from "@/lib/server/diagnostics";
import { after } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { proceedApplicant, deliverEmail } from "@/lib/server/email-outbox";
import { safeError } from "@/lib/server/response";
import { z } from "zod";
import { SafeError } from "@/lib/server/config";
export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireOrigin(request);
    const user = await requireUser(),
      { id } = await params;
    const body = z
      .object({
        expectedStage: z.string().max(60),
        scheduledAt: z.iso.datetime().optional(),
        note: z.string().max(2000).optional(),
        interviewer: z.string().max(200).optional(),
        templateId: z.string().max(254).optional(),
        confirmed: z.literal(true),
      })
      .safeParse(await request.json());
    if (!body.success)
      throw new SafeError(
        "Confirm the next stage and check the interview details.",
      );
    const result = await proceedApplicant(id, body.data, user);
    after(async () => {
      if (result.emailId) {
        try {
          await deliverEmail(result.emailId);
        } catch {
          await reportIssue("notification.failed", {
            entityId: id,
            jobId: result.emailId,
          });
        }
      }
    });
    return Response.json({
      ...result,
      message: result.emailId
        ? "Progression requested. The stage will advance after Gmail confirms the email was sent. Check Email History for delivery or retry."
        : "Demo stage changed. No email sent.",
    });
  } catch (e) {
    return safeError(e);
  }
}
