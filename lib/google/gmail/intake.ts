import { queueExtraction } from "@/lib/server/ai-extraction";
import { evidenceInformation } from "@/lib/applicant-information";
import { recordIssue } from "@/lib/server/diagnostics";
import { intakeEvidence, messageBody } from "@/lib/intake-evidence";
import { matchHiringNeed, senderName } from "@/lib/intake-matching";
import {
  activeIntake,
  intakeCapacity,
  INTAKE_QUEUE_LIMIT,
} from "@/lib/data-policy";
import "server-only";
import { createHash } from "node:crypto";
import mammoth from "mammoth";
import { accessToken } from "./service";
import { validEmail } from "./payload";
import { config, SafeError } from "@/lib/server/config";
import { withStore } from "@/lib/server/store";
import {
  retryableTransaction,
  readTransaction,
  putRecord,
  readRecord,
} from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { seal, unseal } from "@/lib/auth/security";
import type { Application, QualificationRule, User } from "@/types";

const MAX_PREVIEW_MESSAGES = 40;
export { screenResumeAgainstCriteria } from "@/lib/screening";
import { screenResumeAgainstCriteria, buildInsight } from "@/lib/screening";
import { extractResume } from "@/lib/server/documents";
import { withDeadline } from "@/lib/server/deadline";
export function resumeScreeningInsight(
  text: string,
  mime: string,
  criteria: QualificationRule[] = [],
) {
  if (!text.trim())
    return "Resume text could not be extracted. HR must review the original document and record evidence manually.";
  return (
    buildInsight(
      screenResumeAgainstCriteria(text, criteria),
      "the assigned position",
      "the selected location",
    ) +
    (mime.startsWith("image/")
      ? " Image OCR was used; verify the original image."
      : "")
  );
}

type Part = {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: Part[];
};
type Message = {
  id: string;
  threadId: string;
  internalDate: string;
  payload: Part & { headers: { name: string; value: string }[] };
};
export type PreviewRow = {
  messageId: string;
  threadId: string;
  name: string;
  email: string;
  receivedAt: string;
  filename: string;
  mime: string;
  hash: string;
  data: string;
  text: string;
  subject: string;
  rfcId: string;
  extraction?: Application["extraction"];
  emailBody?: string;
  sender?: string;
  appliedPosition?: string;
  appliedLocation?: string;
  residence?: string;
  processingNote?: string;
  evidence?: ReturnType<typeof intakeEvidence>;
};
type Preview = {
  actor: string;
  expiresAt: number;
  rows: PreviewRow[];
  issues: { message: string; reason: string }[];
  used?: boolean;
};
export async function official() {
  const c = await withStore((s) => s.officialConnection, false);
  if (!c || c.email !== config().officialEmail)
    throw new SafeError("Connect the official careers mailbox first.", 409);
  if (!c.scopes?.includes("https://www.googleapis.com/auth/gmail.readonly"))
    throw new SafeError(
      "Authorize Gmail read-only access for applicant intake.",
      409,
    );
  return c;
}
export async function gmail<T>(token: string, url: string): Promise<T> {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${url}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!r.ok)
    throw new SafeError(
      r.status === 401
        ? "Gmail authorization expired. Reconnect the official mailbox."
        : "Gmail could not complete the request. Check authorization and retry.",
      r.status === 401 ? 401 : 502,
    );
  return r.json();
}
function parts(p: Part): Part[] {
  return [p, ...(p.parts || []).flatMap(parts)];
}
export async function previewImport(
  user: User,
  options: { ids?: string[]; deadline?: number; automatic?: boolean } = {},
) {
  if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
    throw new SafeError("Recruitment manager access required.", 403);
  const state = await readTransaction(getState);
  const deadline = options.deadline || Date.now() + 150000;
  const realApps = state.applications.filter(activeIntake);
  const realCount = realApps.filter((a) => a.source === "Gmail").length;
  if (!state.intakeQuery?.trim())
    throw new SafeError(
      "Configure the application email filter in Settings first.",
    );
  const token = await accessToken(await official());
  let page: string | undefined;
  const ids: string[] = [...(options.ids || [])];
  if (!options.ids)
    do {
      const data = await gmail<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(
        token,
        `messages?maxResults=${MAX_PREVIEW_MESSAGES}&q=${encodeURIComponent(state.intakeQuery)}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
      );
      ids.push(...(data.messages || []).map((m) => m.id));
      page = data.nextPageToken;
    } while (page && ids.length < MAX_PREVIEW_MESSAGES);
  const messages: Message[] = [];
  const issues: Preview["issues"] = [];
  for (let n = 0; n < ids.length; n += 8) {
    const batch = await Promise.all(
      ids.slice(n, n + 8).map(async (id) => {
        try {
          return await gmail<Message>(token, `messages/${id}?format=full`);
        } catch {
          return null;
        }
      }),
    );
    batch.forEach((m, i) =>
      m
        ? messages.push(m)
        : issues.push({
            message: ids[n + i],
            reason: "Failed to retrieve message; retry preview to include it.",
          }),
    );
  }
  messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  const rows: PreviewRow[] = [];

  const emails = new Set(
      state.applications.map((a) => a.applicant.email.toLowerCase()),
    ),
    hashes = new Set(state.applications.map((a) => a.resumeHash)),
    threads = new Set(state.applications.map((a) => a.gmailThreadId)),
    seen = new Set(state.applications.map((a) => a.gmailMessageId));
  {
    for (const message of messages) {
      if (Date.now() >= deadline) {
        issues.push({
          message: "Import preview",
          reason:
            "Preview time limit reached. Import the ready records, then retry to continue.",
        });
        break;
      }
      if (rows.length >= 10) break;
      const header = (name: string) =>
        message.payload.headers.find((h) => h.name.toLowerCase() === name)
          ?.value || "";
      const subject = header("subject");
      const from = header("from");
      const email = (from.match(/<([^<>]+)>/)?.[1] || from)
        .trim()
        .toLowerCase();
      const skip = (reason: string) =>
        issues.push({ message: subject || "Untitled message", reason });
      if (!validEmail(email) || email === config().officialEmail) {
        skip("Not an eligible external applicant sender.");
        continue;
      }
      if (
        emails.has(email) ||
        threads.has(message.threadId) ||
        seen.has(message.id)
      ) {
        skip("Duplicate applicant, message, or thread.");
        continue;
      }
      const attachments = parts(message.payload).filter((p) => p.filename);
      const p = attachments.find((p) =>
        /\.(pdf|docx|txt|png|jpe?g)$/i.test(p.filename!),
      );
      if (!p) {
        skip(
          attachments.length
            ? "Unsupported resume format (PDF, DOCX, JPG, PNG, or TXT required)."
            : "Missing resume attachment.",
        );
        continue;
      }
      if ((p.body?.size || 0) > 8 * 1024 * 1024) {
        skip("Resume exceeds the 8 MB limit.");
        continue;
      }
      try {
        const content =
          p.body?.data ||
          (p.body?.attachmentId
            ? (
                await gmail<{ data: string }>(
                  token,
                  `messages/${message.id}/attachments/${p.body.attachmentId}`,
                )
              ).data
            : "");
        if (!content) throw Error();
        const bytes = Buffer.from(content, "base64url");
        if (bytes.length > 8 * 1024 * 1024) throw Error();
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hashes.has(hash)) {
          skip("Duplicate resume.");
          continue;
        }
        const document = await withDeadline(
          extractResume(bytes, p.filename!),
          Math.max(1, deadline - Date.now()),
        );
        const { text: extracted, mime, extraction } = document;
        const emailBody = messageBody(message.payload);
        const evidence = intakeEvidence({
          subject,
          body: emailBody,
          resume: extracted,
          filename: p.filename,
          from,
        });
        rows.push({
          messageId: message.id,
          threadId: message.threadId,
          name: evidence.name,
          evidence,
          emailBody,
          sender: from,
          appliedPosition: evidence.position,
          appliedLocation: evidence.location,
          residence: evidence.residence,
          email,
          receivedAt: new Date(Number(message.internalDate)).toISOString(),
          filename: p.filename!,
          mime,
          hash,
          data: bytes.toString("base64"),
          text: extracted,
          extraction,
          subject: subject.slice(0, 200),
          rfcId: /^<[^<>\s]+@[^<>\s]+>$/.test(header("message-id"))
            ? header("message-id")
            : "",
        });
        emails.add(email);
        hashes.add(hash);
        threads.add(message.threadId);
      } catch {
        skip(
          "Failed to read resume. Check for a damaged or password-protected attachment and retry with an unlocked copy.",
        );
      }
    }
  }
  const id = crypto.randomUUID();
  const prepared: Preview = {
    actor: user.email,
    expiresAt: Date.now() + 15 * 60000,
    rows,
    issues,
  };
  // A manual preview must survive the request so HR can inspect and confirm
  // it. Automatic intake confirms in this same server operation; persisting a
  // temporary binary-heavy preview would add a redundant Drive file and a full
  // Sheets commit before the actual application write.
  if (!options.automatic)
    await retryableTransaction(async (tx) => {
      await putRecord(
        tx,
        "import_previews",
        id,
        seal(prepared, config().encryptionKey),
      );
      await audit(tx, user.email, "Gmail import preview", undefined, {
        eligible: rows.length,
        skipped: issues.length,
      });
    });
  return {
    id,
    rows: rows.map(({ data, text, emailBody, sender, ...r }) => r),
    issues,
    scanned: messages.length,
    automaticPreview: options.automatic ? prepared : undefined,
  };
}
export async function confirmImport(
  user: User,
  id: string,
  selections: { messageId: string; name: string; hiringNeedId: string }[],
  confirmed: boolean,
  automatic = false,
  automaticPreview?: Preview,
) {
  if (!confirmed) throw new SafeError("Confirm the import first.");
  if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
    throw new SafeError("Recruitment manager access required.", 403);
  return retryableTransaction(async (tx) => {
    const encrypted = automaticPreview
      ? null
      : await readRecord<string>(tx, "import_previews", id);
    if (!automaticPreview && !encrypted)
      throw new SafeError("Preview expired. Preview Gmail again.", 409);
    const preview =
      automaticPreview ||
      unseal<Preview>(encrypted as string, config().encryptionKey);
    if (
      preview.used ||
      preview.actor !== user.email ||
      preview.expiresAt < Date.now()
    )
      throw new SafeError(
        "This preview was used or expired. Preview Gmail again.",
        409,
      );
    const state = await getState(tx);
    if (
      !selections.length ||
      selections.length > 10 ||
      new Set(selections.map((s) => s.messageId)).size !== selections.length
    )
      throw new SafeError("Select between 1 and 10 unique applications.");
    let imported = 0;
    const issues = [...preview.issues];
    for (const selection of selections) {
      const r = preview.rows.find((r) => r.messageId === selection.messageId),
        need = state.hiringNeeds.find(
          (n) =>
            n.id === selection.hiringNeedId && n.status === "Open" && !n.isDemo,
        );
      if (
        !r ||
        (!need && !!selection.hiringNeedId) ||
        !selection.name.trim() ||
        selection.name.length > 200
      )
        throw new SafeError(
          "Choose a valid hiring need or leave it unassigned, and verify the applicant name.",
        );
      if (
        state.applications.some(
          (a) =>
            a.gmailMessageId === r.messageId ||
            a.gmailThreadId === r.threadId ||
            a.resumeHash === r.hash ||
            (!a.isDemo &&
              a.applicant.email.toLowerCase() === r.email.toLowerCase()),
        )
      ) {
        issues.push({
          message: r.subject,
          reason: "Duplicate found at confirmation; skipped.",
        });
        continue;
      }
      const position =
        r.appliedPosition ||
        "Applied position was not clearly stated in the submitted application.";
      if (intakeCapacity(state.applications).full) {
        issues.push({
          message: r.subject,
          reason: `Intake capacity is full (${INTAKE_QUEUE_LIMIT} eligible applications). This message remains in Gmail and can be imported when space becomes available.`,
        });
        continue;
      }
      const location =
        r.appliedLocation ||
        "Preferred work location was not clearly stated in the submitted application.";
      const rules = need?.criteria || [];
      const now = new Date().toISOString();
      const sequence =
        ((await readRecord<number>(tx, "sequence", "applicant")) || 0) + 1;
      await putRecord(tx, "sequence", "applicant", sequence);
      const applicationId = `DJC-${new Date().getFullYear()}-${String(sequence).padStart(5, "0")}`,
        resumeId = crypto.randomUUID();
      await tx.query(
        "INSERT INTO resumes(id,sha256,filename,mime,content,extracted_text) VALUES($1,$2,$3,$4,$5,$6)",
        [
          resumeId,
          r.hash,
          r.filename,
          r.mime,
          seal(r.data, config().encryptionKey),
          seal(r.text, config().encryptionKey),
        ],
      );
      const extracted =
        r.evidence ||
        intakeEvidence({
          subject: r.subject,
          body: r.emailBody || "",
          resume: r.text,
          filename: r.filename,
          from: r.sender || "",
        });
      const a: Application = {
        id: applicationId,
        information: evidenceInformation(extracted),
        applicant: {
          id: crypto.randomUUID(),
          name: selection.name.trim(),
          email: r.email,
          phone:
            r.text.match(/(?:\+63|0)9\d{2}[ -]?\d{3}[ -]?\d{4}/)?.[0] || "",
          location: r.residence || "Not verified",
          experience: 0,
          education: extracted.education,
          availability: extracted.availability,
          experienceDetails: extracted.experienceDetails,
        },
        position,
        location,
        hiringNeedId: need?.id,
        appliedAt: r.receivedAt,
        stage: "Screening",
        status: "New",
        screening: {
          outcome: "Requires Review",
          completedAt: "",
          insight: buildInsight(
            screenResumeAgainstCriteria(
              r.text,
              rules,
              !r.extraction?.warnings.length,
            ),
            position,
            location,
            !!r.text.trim(),
          ),
          method: "rules",
          criteria: screenResumeAgainstCriteria(
            r.text,
            rules,
            !r.extraction?.warnings.length,
          ),
        },
        lastActivity: now,
        notes: [
          ...(need
            ? []
            : [
                "Hiring need could not be matched confidently. Confirm position and location before screening.",
              ]),
          ...(r.processingNote ? [r.processingNote] : []),
        ],
        interviews: [],
        requirements: state.requirementTemplates.map((r) => ({
          ...r,
          status: "Pending",
          notes: "",
        })),
        timeline: [
          {
            id: crypto.randomUUID(),
            timestamp: now,
            user: user.email,
            action: "Application imported from Gmail",
            applicationId,
            metadata: {
              receivedAt: r.receivedAt,
              communication: "No email sent",
            },
          },
        ],
        gmailMessageId: r.messageId,
        gmailThreadId: r.threadId,
        rfcMessageId: r.rfcId,
        originalSubject: r.subject,
        resumeId,
        resumeHash: r.hash,
        extraction: r.extraction,
        source: "Gmail",
        assignedTo: user.email,
        onboardingStatus: "Pending Orientation",
      };
      if (!automatic && selection.name.trim() !== extracted.name) {
        a.information!.fields.name = {
          source: "HR edit",
          confidence: "Confident",
          evidence: "Name corrected during import review.",
          verifiedBy: user.email,
        };
      }
      state.applications.push(a);
      await putRecord(
        tx,
        "application_sources",
        a.id,
        seal(
          {
            subject: r.subject,
            body: r.emailBody || "",
            from: r.sender || "",
            filename: r.filename,
          },
          config().encryptionKey,
        ),
      );
      await queueExtraction(tx, a, user.email);
      if (a.extraction?.warnings.length)
        await recordIssue(
          "documents.extraction",
          { entityId: a.id, user: user.email },
          tx,
        );
      await audit(tx, user.email, "application.imported", a.id, {
        messageId: r.messageId,
        threadId: r.threadId,
      });
      imported++;
    }
    if (!automaticPreview) {
      preview.used = true;
      await putRecord(
        tx,
        "import_previews",
        id,
        seal({ ...preview, rows: [] }, config().encryptionKey),
      );
    }
    await saveState(tx, state);
    return {
      imported,
      skipped: issues.length,
      issues,
      total: state.applications.length,
      limit: state.importLimit,
    };
  });
}
