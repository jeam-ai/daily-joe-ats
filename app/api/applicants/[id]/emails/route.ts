import { after } from "next/server";
import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import {
  emailHistory,
  deliverEmail,
  verifySentEmail,
  refreshFailedEmail,
} from "@/lib/server/email-outbox";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(),
      { id } = await params;
    const emails = await emailHistory(id, user);
    if (emails.some((m) => m.status === "Queued" || m.status === "Sending"))
      after(() => drainEmailOutbox());
    return Response.json(
      { emails },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireOrigin(request);
    const user = await requireUser(),
      { id } = await params,
      body = await request.json();
    if (
      !["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role) ||
      body.confirmed !== true
    )
      throw new SafeError(
        "A recruitment manager must confirm this action.",
        403,
      );
    const mail = (await emailHistory(id, user)).find(
      (m) => m.id === body.emailId,
    );
    if (!mail) throw new SafeError("Email record not found.", 404);
    if (body.action === "verify")
      return Response.json({ email: await verifySentEmail(mail.id, user) });
    if (body.action === "retry")
      return Response.json({ email: await deliverEmail(mail.id, user, true) });
    if (body.action === "prepare")
      return Response.json({ email: await refreshFailedEmail(mail.id, user) });
    throw new SafeError("Choose Retry or Check Gmail.");
  } catch (e) {
    return safeError(e);
  }
}
