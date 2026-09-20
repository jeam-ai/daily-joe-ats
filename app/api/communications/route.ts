import { requireOrigin, requireUser } from "@/lib/auth/session";
import { config, SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { transaction, readRecord, putRecord } from "@/lib/server/database";
import { getState, saveState } from "@/lib/server/repository";
import { validateEmailInput } from "@/lib/google/gmail/payload";
import { emailContext, renderEmail } from "@/lib/email-templates";
import {
  queueEmail,
  deliverEmail,
  sourceFingerprint,
} from "@/lib/server/email-outbox";
import { seal, unseal } from "@/lib/auth/security";
import { canManage } from "@/lib/data-policy";
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
  fingerprint: string;
  expiresAt: number;
  emailId?: string;
};
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError(
        "A recruitment manager must send applicant communications.",
        403,
      );
    const raw = await req.text();
    if (raw.length > 16000) throw new SafeError("Message too large.");
    const body = JSON.parse(raw);
    if (body.action === "preview") {
      const draft = await transaction(async (tx) => {
        const state = await getState(tx),
          a = state.applications.find(
            (a) => a.id === body.applicationId && !a.deletedAt && !a.isDemo,
          );
        if (!a)
          throw new SafeError("Email is unavailable for this applicant.", 403);
        const template = state.emailTemplates.find(
          (t) => t.id === body.templateId && t.enabled !== false,
        );
        if (!template) throw new SafeError("Select an enabled email template.");
        let input;
        try {
          input = validateEmailInput(
            { to: a.applicant.email, subject: body.subject, body: body.body },
            a.applicant.email,
          );
        } catch {
          throw new SafeError("Enter a valid subject and message.");
        }
        const rendered = renderEmail(input, emailContext(a, state, user));
        if (rendered.missing.length)
          throw new SafeError(
            `Complete template values: ${rendered.missing.join(", ")}.`,
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
          subject: reply ? a.originalSubject! : rendered.subject,
          body: rendered.body,
          templateId: template.id,
          threadId: reply ? a.gmailThreadId : undefined,
          inReplyTo: reply ? a.rfcMessageId : undefined,
          fingerprint: sourceFingerprint(a),
          expiresAt: Date.now() + 900000,
        };
        await putRecord(
          tx,
          "communication_previews",
          draft.id,
          seal(draft, config().encryptionKey),
        );
        return draft;
      });
      return Response.json({ draft });
    }
    if (
      body.action !== "send" ||
      body.confirmed !== true ||
      typeof body.id !== "string"
    )
      throw new SafeError("Preview and confirm this email first.");
    const id = await transaction(async (tx) => {
      const enc = await readRecord<string>(
        tx,
        "communication_previews",
        body.id,
      );
      if (!enc)
        throw new SafeError("Preview expired. Review a fresh message.", 409);
      const draft = unseal<Draft>(enc, config().encryptionKey);
      if (draft.actor !== user.email)
        throw new SafeError("This preview belongs to another HR user.", 403);
      if (draft.emailId) return draft.emailId;
      if (draft.expiresAt < Date.now())
        throw new SafeError("Preview expired. Review a fresh message.", 409);
      const state = await getState(tx),
        a = state.applications.find(
          (a) => a.id === draft.applicationId && !a.deletedAt && !a.isDemo,
        );
      if (!a)
        throw new SafeError("Email is unavailable for this applicant.", 403);
      if (sourceFingerprint(a) !== draft.fingerprint)
        throw new SafeError(
          "Applicant information changed. Review a fresh preview.",
          409,
        );
      const template = state.emailTemplates.find(
        (t) => t.id === draft.templateId && t.enabled !== false,
      );
      if (!template)
        throw new SafeError("The template is no longer available.");
      const mail = await queueEmail(
        tx,
        state,
        a,
        user,
        template,
        `manual:${draft.id}`,
        "HR communication",
        draft,
      );
      draft.emailId = mail.id;
      await putRecord(
        tx,
        "communication_previews",
        draft.id,
        seal(draft, config().encryptionKey),
      );
      await saveState(tx, state, { sync: false });
      return mail.id;
    });
    const mail = await deliverEmail(id, user);
    return Response.json({
      email: mail,
      message:
        mail.status === "Sent"
          ? "Email sent successfully."
          : `Email ${mail.status.toLowerCase()}. Open Email history for details and recovery.`,
    });
  } catch (e) {
    return safeError(e);
  }
}
