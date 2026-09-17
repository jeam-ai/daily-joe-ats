import { requireOrigin, requireUser } from "@/lib/auth/session";
import { config, SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { withStore } from "@/lib/server/store";
import { transaction, readRecord, putRecord } from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { validateEmailInput } from "@/lib/google/gmail/payload";
import { sendEmail } from "@/lib/google/gmail/service";
import { syncSheets } from "@/lib/google/sheets";
type Draft = {
  id: string;
  applicationId: string;
  actor: string;
  to: string;
  subject: string;
  body: string;
  templateId: string;
  threadId?: string;
  inReplyTo?: string;
  revision: number;
  expiresAt: number;
  status: "draft" | "pending" | "sent" | "unconfirmed";
  messageId?: string;
};
export const runtime = "nodejs";
export async function POST(req: Request) {
  let sending: Draft | undefined;
  try {
    requireOrigin(req);
    const user = await requireUser();
    if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
      throw new SafeError(
        "A recruitment manager must send applicant communications.",
        403,
      );
    const raw = await req.text();
    if (raw.length > 16000) throw new SafeError("Message too large.");
    const body = JSON.parse(raw);
    const connection = await withStore((s) => s.officialConnection, false);
    if (!connection || connection.email !== config().officialEmail)
      throw new SafeError(
        "Connect the official careers Gmail mailbox before preparing applicant email.",
        409,
      );
    if (body.action === "preview") {
      const draft = await transaction(async (tx) => {
        const state = await getState(tx);
        const a = state.applications.find((a) => a.id === body.applicationId);
        if (!a) throw new SafeError("Application not found.", 404);
        if (!state.emailTemplates.some((t) => t.id === body.templateId))
          throw new SafeError("Select an email template.");
        let input;
        try {
          input = validateEmailInput(
            { to: a.applicant.email, subject: body.subject, body: body.body },
            a.applicant.email,
          );
        } catch (e) {
          throw new SafeError((e as Error).message);
        }
        if (/\{\{|\[(?:HR:|date\]|time\])/.test(input.subject + input.body))
          throw new SafeError(
            "Replace all template variables and HR instructions before sending.",
          );
        const reply =
          body.reply === true &&
          a.gmailThreadId &&
          a.rfcMessageId &&
          a.originalSubject;
        const draft: Draft = {
          id: crypto.randomUUID(),
          applicationId: a.id,
          actor: user.email,
          ...input,
          subject: reply ? a.originalSubject! : input.subject,
          templateId: body.templateId,
          threadId: reply ? a.gmailThreadId : undefined,
          inReplyTo: reply ? a.rfcMessageId : undefined,
          revision: state.revision || 0,
          expiresAt: Date.now() + 15 * 60000,
          status: "draft",
        };
        await putRecord(tx, "email_drafts", draft.id, draft);
        return draft;
      });
      return Response.json({ draft });
    }
    if (
      body.action !== "send" ||
      body.confirmed !== true ||
      typeof body.id !== "string"
    )
      throw new SafeError("Preview the email and explicitly confirm sending.");
    sending = await transaction(async (tx) => {
      const draft = await readRecord<Draft>(tx, "email_drafts", body.id),
        state = await getState(tx);
      if (
        !draft ||
        draft.actor !== user.email ||
        draft.status !== "draft" ||
        draft.expiresAt < Date.now()
      )
        throw new SafeError(
          "Draft was used or expired. Check Sent mail before creating another.",
          409,
        );
      if (draft.revision !== state.revision)
        throw new SafeError(
          "The workspace changed. Review a fresh email preview.",
          409,
        );
      draft.status = "pending";
      await putRecord(tx, "email_drafts", draft.id, draft);
      await audit(tx, user.email, "email.send.requested", draft.applicationId, {
        draftId: draft.id,
        to: draft.to,
      });
      return draft;
    });
    const sent = await sendEmail(sending, connection);
    const draft = sending;
    await transaction(async (tx) => {
      const state = await getState(tx);
      const a = state.applications.find((a) => a.id === draft.applicationId)!;
      const now = new Date().toISOString();
      a.timeline.push({
        id: crypto.randomUUID(),
        timestamp: now,
        user: user.email,
        action: "Email sent",
        applicationId: a.id,
        metadata: {
          recipient: draft.to,
          sender: connection.email,
          subject: draft.subject,
          templateId: draft.templateId,
          messageId: sent.messageId,
          threadId: sent.threadId || "",
          communication: "Sent through Gmail",
        },
      });
      a.lastActivity = now;
      draft.status = "sent";
      draft.messageId = sent.messageId;
      await putRecord(tx, "email_drafts", draft.id, draft);
      await audit(tx, user.email, "email.sent", a.id, {
        messageId: sent.messageId,
        threadId: sent.threadId,
      });
      await saveState(tx, state);
    });
    return Response.json({
      message: "Email sent successfully.",
      syncStatus: await syncSheets(),
    });
  } catch (e) {
    if (sending) {
      const draft = sending;
      await transaction(async (tx) => {
        draft.status = "unconfirmed";
        await putRecord(tx, "email_drafts", draft.id, draft);
        await audit(
          tx,
          draft.actor,
          "email.delivery.unconfirmed",
          draft.applicationId,
          {
            draftId: draft.id,
            note: "Check Gmail Sent before attempting another send.",
          },
        );
      }).catch(() => {});
    }
    return safeError(e);
  }
}
