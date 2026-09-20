import "server-only";
import { createHash } from "node:crypto";
import type { Application, AppState, User, EmailTemplate } from "@/types";
import type { EmailRecord } from "@/types/email";
import {
  emailContext,
  renderEmail,
  workflowTemplate,
} from "@/lib/email-templates";
import { transition, nextStage } from "@/lib/recruitment";
import { canManage } from "@/lib/data-policy";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { getState, saveState, audit } from "./repository";
import { SafeError, config } from "./config";
import { seal, unseal } from "@/lib/auth/security";
import { withStore } from "./store";
import {
  sendEmail,
  accessToken,
  GmailSendError,
} from "@/lib/google/gmail/service";
import { recordIssue, reportIssue, resolveIssue } from "./diagnostics";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const sourceFingerprint = (a: Application) =>
  hash(
    JSON.stringify({
      email: a.applicant.email,
      name: a.applicant.name,
      stage: a.stage,
      interviews: a.interviews,
    }),
  );
async function readMail(tx: Transaction, id: string) {
  const encrypted = await readRecord<string>(tx, "email_outbox", id);
  return encrypted
    ? unseal<EmailRecord>(encrypted, config().encryptionKey)
    : null;
}
async function saveMail(tx: Transaction, m: EmailRecord) {
  await putRecord(tx, "email_outbox", m.id, seal(m, config().encryptionKey));
  await putRecord(tx, "email_index", m.id, {
    id: m.id,
    applicationId: m.applicationId,
    status: m.status,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    attempts: m.attempts,
    errorCode: m.errorCode,
  });
}
async function event(
  tx: Transaction,
  state: AppState,
  m: EmailRecord,
  action: string,
  description: string,
) {
  const a = state.applications.find((a) => a.id === m.applicationId);
  const at = new Date().toISOString();
  if (a) {
    a.timeline.push({
      id: crypto.randomUUID(),
      applicationId: a.id,
      timestamp: at,
      user: m.actor,
      action: description,
      metadata: {
        emailId: m.id,
        subject: m.subject,
        communication: m.status,
        note: m.error || "",
      },
    });
    a.lastActivity = at;
  }
  await audit(tx, m.actor, action, m.applicationId, {
    emailId: m.id,
    templateId: m.templateId,
    workflow: m.workflow,
    status: m.status,
    messageId: m.messageId,
    threadId: m.threadId,
  });
}
export async function queueEmail(
  tx: Transaction,
  state: AppState,
  a: Application,
  user: User,
  template: EmailTemplate,
  key: string,
  workflow: string,
  overrides?: {
    subject: string;
    body: string;
    threadId?: string;
    inReplyTo?: string;
  },
) {
  const id = hash(key),
    existing = await readMail(tx, id);
  if (existing) return existing;
  if (a.isDemo || a.deletedAt)
    throw new SafeError(
      "Demo or deleted applicants cannot receive email.",
      403,
    );
  const rendered = renderEmail(
    overrides || template,
    emailContext(a, state, user),
  );
  const now = new Date().toISOString();
  const m: EmailRecord = {
    id,
    applicationId: a.id,
    actor: user.email,
    recipient: a.applicant.email,
    sender: config().officialEmail,
    subject: rendered.subject,
    body: rendered.body,
    templateId: template.id,
    templateName: template.name,
    templateVersion: hash(JSON.stringify(template)),
    workflow,
    status: rendered.missing.length ? "Failed" : "Queued",
    createdAt: now,
    attempts: 0,
    rfcMessageId: `<djc-${id}@daily-joe.com>`,
    sourceFingerprint: sourceFingerprint(a),
  };
  if (overrides?.threadId && overrides?.inReplyTo) {
    m.replyThreadId = overrides.threadId;
    m.inReplyTo = overrides.inReplyTo;
  }
  if (rendered.missing.length) {
    m.error = `Email not sent. Missing template values: ${rendered.missing.join(", ")}. Edit the template or applicant details, then retry this email.`;
    m.errorCode = "template";
  }
  await saveMail(tx, m);
  await event(
    tx,
    state,
    m,
    m.status === "Failed" ? "email.failed" : "email.queued",
    m.status === "Failed" ? "Email failed — action required" : "Email queued",
  );
  if (m.status === "Failed")
    await recordIssue(
      "notification.failed",
      { entityId: a.id, jobId: m.id },
      tx,
    );
  return m;
}
export async function proceedApplicant(
  id: string,
  input: {
    expectedStage: string;
    scheduledAt?: string;
    note?: string;
    interviewer?: string;
    templateId?: string;
    confirmed?: boolean;
  },
  user: User,
) {
  if (!canManage(user))
    throw new SafeError(
      "A recruitment manager must proceed an application.",
      403,
    );
  if (!input.confirmed)
    throw new SafeError("Confirm the stage change and configured email first.");
  const key = hash(`${id}:${input.expectedStage}:proceed`);
  return transaction(async (tx) => {
    const previous = await readRecord<{ emailId?: string; stage: string }>(
      tx,
      "transitions",
      key,
    );
    if (previous) return previous;
    const state = await getState(tx),
      a = state.applications.find((a) => a.id === id && !a.deletedAt);
    if (!a) throw new SafeError("Applicant not found.", 404);
    if (a.stage !== input.expectedStage)
      throw new SafeError(
        "The applicant stage changed. Refresh before proceeding.",
        409,
      );
    let next: Application;
    try {
      next = transition(a, "Proceed", {
        confirmed: true,
        scheduledAt: input.scheduledAt,
        note: input.note,
        actor: user.email,
      });
    } catch (e) {
      throw new SafeError((e as Error).message);
    }
    if (input.interviewer && next.interviews.length)
      next.interviews.at(-1)!.notes =
        `Interviewer: ${input.interviewer.slice(0, 200)}`;
    if (next.stage === "Hired")
      next.employment = {
        status: "Active",
        date: new Date().toISOString().slice(0, 10),
        notes: "",
        actor: user.email,
      };
    state.applications = state.applications.map((v) =>
      v.id === id ? next : v,
    );
    await audit(tx, user.email, "application.stage_changed", id, {
      previous: a.stage,
      next: next.stage,
    });
    let emailId: string | undefined;
    if (!a.isDemo) {
      const template = workflowTemplate(state, next.stage);
      if (input.templateId && template?.id !== input.templateId)
        throw new SafeError(
          "The workflow template changed. Refresh and review it before proceeding.",
          409,
        );
      if (template)
        emailId = (
          await queueEmail(
            tx,
            state,
            next,
            user,
            template,
            key,
            `${a.stage} → ${next.stage}`,
          )
        ).id;
      else {
        const missing = {
          id: "missing",
          name: `${next.stage} (not configured)`,
          subject: "Daily Joe Careers",
          body: "{{configured_workflow_template}}",
        };
        emailId = (
          await queueEmail(
            tx,
            state,
            next,
            user,
            missing,
            key,
            `${a.stage} → ${next.stage}`,
          )
        ).id;
      }
    }
    await saveState(tx, state, { sync: !a.isDemo });
    const result = { stage: next.stage, emailId };
    await putRecord(tx, "transitions", key, result);
    return result;
  });
}
export async function emailHistory(applicationId: string, user: User) {
  return readTransaction(async (tx) => {
    const state = await getState(tx);
    if (!state.applications.some((a) => a.id === applicationId && !a.deletedAt))
      throw new SafeError("Applicant not found.", 404);
    const rows = await tx.query(
      "SELECT id,payload FROM records WHERE collection=$1",
      ["email_index"],
    );
    const ids = rows
      .filter(
        (r) => JSON.parse(String(r.payload)).applicationId === applicationId,
      )
      .map((r) => String(r.id));
    return (await Promise.all(ids.map((id) => readMail(tx, id))))
      .filter((m): m is EmailRecord => !!m)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}
export async function deliverEmail(id: string, user?: User, retry = false) {
  const claimed = await transaction(async (tx) => {
    const m = await readMail(tx, id);
    if (!m) throw new SafeError("Email record not found.", 404);
    if (m.status === "Sent" || m.status === "Unconfirmed")
      return { mail: m, send: false };
    if (m.status === "Sending") {
      if ((m.leaseUntil || 0) > Date.now()) return { mail: m, send: false };
      m.status = "Unconfirmed";
      m.error =
        "The send was interrupted. Check Gmail before any further send.";
      const state = await getState(tx);
      await saveMail(tx, m);
      await event(
        tx,
        state,
        m,
        "email.interrupted",
        "Email confirmation requires review",
      );
      await recordIssue(
        "notification.failed",
        { entityId: m.applicationId, jobId: m.id },
        tx,
      );
      await saveState(tx, state, { sync: false });
      return { mail: m, send: false };
    }
    if (m.status === "Failed" && !retry) return { mail: m, send: false };
    if (retry && !user)
      throw new SafeError("An authorized user must retry this email.", 403);
    const state = await getState(tx),
      a = state.applications.find(
        (a) => a.id === m.applicationId && !a.deletedAt && !a.isDemo,
      );
    if (!a) throw new SafeError("Email is unavailable for this record.", 403);
    if (retry) {
      if (!canManage(user!))
        throw new SafeError("Recruitment manager access required.", 403);
      if (m.errorCode === "template") {
        const template =
          state.emailTemplates.find((t) => t.id === m.templateId) ||
          workflowTemplate(state, a.stage);
        if (!template)
          throw new SafeError("Configure this stage's email template first.");
        const rendered = renderEmail(template, emailContext(a, state, user!));
        if (rendered.missing.length)
          throw new SafeError(
            `Missing template values: ${rendered.missing.join(", ")}.`,
          );
        Object.assign(m, {
          subject: rendered.subject,
          body: rendered.body,
          templateId: template.id,
          templateName: template.name,
          templateVersion: hash(JSON.stringify(template)),
          sourceFingerprint: sourceFingerprint(a),
          recipient: a.applicant.email,
        });
      }
      await event(tx, state, m, "email.retried", "Email retry requested");
    }
    if (sourceFingerprint(a) !== m.sourceFingerprint) {
      m.status = "Failed";
      m.errorCode = "changed";
      m.error =
        "Applicant details changed. Prepare and review a fresh message before sending.";
      await saveMail(tx, m);
      await event(
        tx,
        state,
        m,
        "email.failed",
        "Email paused after applicant information changed",
      );
      await recordIssue(
        "notification.failed",
        { entityId: a.id, jobId: m.id },
        tx,
      );
      await saveState(tx, state, { sync: false });
      return { mail: m, send: false };
    }
    m.status = "Sending";
    m.attempts++;
    m.leaseUntil = Date.now() + 90000;
    delete m.error;
    delete m.errorCode;
    await saveMail(tx, m);
    await saveState(tx, state, { sync: false });
    return { mail: m, send: true };
  });
  if (!claimed.send) return claimed.mail;
  const m = claimed.mail;
  try {
    const connection = await withStore((s) => s.officialConnection, false);
    if (!connection || connection.email !== config().officialEmail)
      throw new GmailSendError(
        "Connect the official Gmail account before retrying this email.",
        409,
        true,
      );
    const sent = await sendEmail(
      {
        to: m.recipient,
        subject: m.subject,
        body: m.body,
        messageId: m.rfcMessageId,
        threadId: m.replyThreadId,
        inReplyTo: m.inReplyTo,
      },
      connection,
    );
    m.status = "Sent";
    m.sentAt = new Date().toISOString();
    m.messageId = sent.messageId;
    m.threadId = sent.threadId;
    delete m.leaseUntil;
    await transaction(async (tx) => {
      const existing = await readMail(tx, id);
      if (existing?.status === "Sent") return;
      const state = await getState(tx);
      await saveMail(tx, m);
      await event(tx, state, m, "email.sent", "Email sent");
      await saveState(tx, state, { sync: false });
    });
    // Delivery is already committed; monitoring failure must not change it.
    await resolveIssue("notification.failed", {
      entityId: m.applicationId,
      jobId: m.id,
    }).catch(() => undefined);
    return m;
  } catch (e) {
    const safe = e instanceof GmailSendError && e.definitelyNotSent;
    m.status = safe ? "Failed" : "Unconfirmed";
    m.error =
      e instanceof SafeError
        ? e.message
        : "Sending could not be confirmed. Check Gmail before retrying.";
    m.errorCode = safe ? "provider" : "unconfirmed";
    delete m.leaseUntil;
    await transaction(async (tx) => {
      const saved = await readMail(tx, id);
      if (saved?.status === "Sent") return;
      const state = await getState(tx);
      await saveMail(tx, m);
      await event(
        tx,
        state,
        m,
        "email.failed",
        safe
          ? "Email failed — action required"
          : "Email confirmation requires review",
      );
      await saveState(tx, state, { sync: false });
      await recordIssue(
        "notification.failed",
        { entityId: m.applicationId, jobId: m.id },
        tx,
      );
    });
    return m;
  }
}
export async function verifySentEmail(id: string, user: User) {
  if (!canManage(user))
    throw new SafeError("Recruitment manager access required.", 403);
  const m = await readTransaction((tx) => readMail(tx, id));
  if (!m) throw new SafeError("Email not found.", 404);
  if (m.status !== "Unconfirmed") return m;
  const c = await withStore((s) => s.officialConnection, false);
  if (!c) throw new SafeError("Reconnect Gmail before checking Sent mail.");
  const token = await accessToken(c);
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=2&q=${encodeURIComponent(`in:sent rfc822msgid:${m.rfcMessageId}`)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok)
    throw new SafeError(
      "Gmail could not verify this message. Keep it unconfirmed and check Sent mail manually.",
    );
  const data = await r.json();
  if (!data.messages?.length)
    throw new SafeError(
      "Gmail has not found a matching sent message yet. No resend was attempted; verify Sent mail before preparing another message.",
      409,
    );
  const found = data.messages[0];
  const detail = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(found.id)}?format=metadata`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!detail.ok)
    throw new SafeError(
      "Gmail found the message but could not verify its timestamp. Try verification again.",
    );
  const metadata = await detail.json();
  const sentTime = Number(metadata.internalDate);
  if (!Number.isFinite(sentTime) || sentTime <= 0)
    throw new SafeError("Gmail did not return a valid delivery timestamp.");
  m.status = "Sent";
  m.messageId = found.id;
  m.threadId = found.threadId;
  m.sentAt = new Date(sentTime).toISOString();
  delete m.error;
  await transaction(async (tx) => {
    const current = await readMail(tx, id);
    if (current?.status === "Sent") return;
    const state = await getState(tx);
    await saveMail(tx, m);
    await event(
      tx,
      state,
      m,
      "email.sent_verified",
      "Email send verified in Gmail",
    );
    await saveState(tx, state, { sync: false });
  });
  await resolveIssue("notification.failed", {
    entityId: m.applicationId,
    jobId: m.id,
  });
  return m;
}
export async function drainEmailOutbox(limit = 5) {
  const entries = await readTransaction(async (tx) =>
    (
      await tx.query("SELECT payload FROM records WHERE collection=$1", [
        "email_index",
      ])
    )
      .map((r) => JSON.parse(String(r.payload)))
      .filter((m) => m.status === "Queued" || m.status === "Sending")
      .slice(0, limit),
  );
  for (const entry of entries) {
    try {
      await deliverEmail(entry.id);
    } catch {
      await reportIssue("notification.failed", {
        entityId: entry.applicationId,
        jobId: entry.id,
      });
    }
  }
}
