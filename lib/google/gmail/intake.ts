import "server-only";
import { createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { accessToken } from "./service";
import { validEmail } from "./payload";
import { config, SafeError } from "@/lib/server/config";
import { withStore } from "@/lib/server/store";
import { transaction, putRecord, readRecord } from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { seal, unseal } from "@/lib/auth/security";
import type { Application, QualificationRule, User } from "@/types";

const MAX_RESUME_TEXT_LENGTH = 100_000;
const MAX_PREVIEW_MESSAGES = 40;
const OCR_BATCH_TIMEOUT_MS = 75_000;
const OCR_STARTUP_TIMEOUT_MS = 20_000;
const OCR_IMAGE_TIMEOUT_MS = 12_000;
type OcrWorker = {
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

function hasPrefix(bytes: Buffer, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function limitOcr<T>(work: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("OCR timed out.")), timeoutMs);
    work.then(
      (value) => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createImageTextExtractor() {
  let pendingWorker: Promise<OcrWorker> | undefined;
  let worker: OcrWorker | undefined;
  let closed = false;
  let unavailable = false;
  const deadline = Date.now() + OCR_BATCH_TIMEOUT_MS;

  function timeout(limit: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("OCR batch timed out.");
    return Math.min(limit, remaining);
  }

  async function startWorker() {
    if (closed || unavailable) throw new Error("OCR session is unavailable.");
    if (!pendingWorker) {
      // Use no persistent language-data cache: Vercel filesystems are read-only.
      // The initialized worker is reused for every image in this import batch.
      const { createWorker } = await import("tesseract.js");
      pendingWorker = createWorker("eng", undefined, {
        cacheMethod: "none",
        logger: () => undefined,
        errorHandler: () => undefined,
      });
    }
    worker = await limitOcr(pendingWorker, timeout(OCR_STARTUP_TIMEOUT_MS));
    return worker;
  }

  return {
    async extract(bytes: Buffer) {
      try {
        const activeWorker = await startWorker();
        const result = await limitOcr(
          activeWorker.recognize(bytes),
          timeout(OCR_IMAGE_TIMEOUT_MS),
        );
        return result.data.text.replaceAll("\0", "").trim();
      } catch {
        unavailable = true;
        if (worker) {
          await worker.terminate().catch(() => undefined);
          worker = undefined;
        }
        return "";
      }
    },
    async close() {
      closed = true;
      if (worker) await worker.terminate().catch(() => undefined);
      else if (pendingWorker)
        void pendingWorker
          .then((lateWorker) => lateWorker.terminate())
          .catch(() => undefined);
    },
  };
}

function escapedExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function screenResumeAgainstCriteria(
  text: string,
  criteria: QualificationRule[],
) {
  return criteria.map((criterion) => {
    const label = criterion.label.trim().replace(/\s+/g, " ");
    const expression = label
      .split(/\s+/)
      .filter(Boolean)
      .map(escapedExpression)
      .join("\\s+");
    const match = expression ? new RegExp(expression, "i").exec(text) : null;
    if (match) {
      const start = Math.max(0, match.index - 70);
      const end = Math.min(text.length, match.index + match[0].length + 70);
      const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
      return {
        id: criterion.id,
        requirement: criterion.label,
        result: "Met" as const,
        evidence: `Direct resume mention detected: “${excerpt}”. HR must verify it in the original resume.`,
      };
    }
    return {
      id: criterion.id,
      requirement: criterion.label,
      result: "Unclear" as const,
      evidence:
        "No direct text match was detected. Missing OCR or resume text is not a failed qualification; HR must review the original resume.",
    };
  });
}

export function resumeScreeningInsight(
  text: string,
  mime: string,
  criteria: QualificationRule[] = [],
) {
  const extracted = text.trim();
  const image = mime.startsWith("image/");
  if (!extracted)
    return image
      ? "Image resume received, but OCR could not extract reliable text. HR must review the original image and record evidence manually."
      : "Resume text could not be extracted. HR must review the original document and record evidence manually.";

  const signals: string[] = [];
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(extracted))
    signals.push("an email address");
  if (/(?:\+?63|0)?9\d{9}\b|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(extracted))
    signals.push("a phone-number pattern");
  if (/\b\d{1,2}\+?\s*(?:years?|yrs?)\b|\bexperience\b/i.test(extracted))
    signals.push("an experience reference");

  const source = image ? "Image OCR" : "Resume text";
  const observed = signals.length
    ? ` It also detected ${signals.join(", ")}.`
    : "";
  const matches = screenResumeAgainstCriteria(extracted, criteria).filter(
    (criterion) => criterion.result === "Met",
  ).length;
  const qualificationSummary = criteria.length
    ? ` ${matches} of ${criteria.length} configured qualifications had a direct text match.`
    : " No hiring-need qualifications are configured yet.";
  return `${source} extracted ${extracted.length.toLocaleString()} characters.${observed}${qualificationSummary} This is a preliminary signal only; HR must verify it against the original resume and configured criteria.`;
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
};
type Preview = {
  actor: string;
  expiresAt: number;
  rows: PreviewRow[];
  issues: { message: string; reason: string }[];
  used?: boolean;
};
async function official() {
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
async function gmail<T>(token: string, url: string): Promise<T> {
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
export async function previewImport(user: User) {
  if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
    throw new SafeError("Recruitment manager access required.", 403);
  const state = await transaction(getState);
  if (state.applications.length >= (state.importLimit || 100))
    throw new SafeError("Applicant import limit reached.", 409);
  if (!state.intakeQuery?.trim())
    throw new SafeError(
      "Configure the application email filter in Settings first.",
    );
  const token = await accessToken(await official());
  let page: string | undefined;
  const ids: string[] = [];
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
  const imageText = createImageTextExtractor();
  const emails = new Set(
      state.applications.map((a) => a.applicant.email.toLowerCase()),
    ),
    hashes = new Set(state.applications.map((a) => a.resumeHash)),
    threads = new Set(state.applications.map((a) => a.gmailThreadId)),
    seen = new Set(state.applications.map((a) => a.gmailMessageId));
  try {
    for (const message of messages) {
      if (
        rows.length >=
        Math.min(10, (state.importLimit || 100) - state.applications.length)
      )
        break;
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
        let extracted = "",
          mime = "text/plain",
          isImage = false;
        if (/\.pdf$/i.test(p.filename!)) {
          if (bytes.subarray(0, 5).toString() !== "%PDF-") throw Error();
          mime = "application/pdf";
          const parser = new PDFParse({ data: bytes });
          try {
            extracted = (await parser.getText()).text;
          } finally {
            await parser.destroy();
          }
        } else if (/\.docx$/i.test(p.filename!)) {
          mime =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          extracted = (await mammoth.extractRawText({ buffer: bytes })).value;
        } else if (/\.jpe?g$/i.test(p.filename!)) {
          if (!hasPrefix(bytes, [0xff, 0xd8, 0xff])) throw Error();
          mime = "image/jpeg";
          isImage = true;
          extracted = await imageText.extract(bytes);
        } else if (/\.png$/i.test(p.filename!)) {
          if (
            !hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          )
            throw Error();
          mime = "image/png";
          isImage = true;
          extracted = await imageText.extract(bytes);
        } else extracted = bytes.toString("utf8");
        if (!extracted.trim() && !isImage) {
          skip(
            "Unreadable or scanned resume. Use PDF/DOCX text or upload the original image for HR review.",
          );
          continue;
        }
        rows.push({
          messageId: message.id,
          threadId: message.threadId,
          name: from.includes("<")
            ? from.split("<")[0].trim().replace(/^"|"$/g, "")
            : email.split("@")[0],
          email,
          receivedAt: new Date(Number(message.internalDate)).toISOString(),
          filename: p.filename!,
          mime,
          hash,
          data: bytes.toString("base64"),
          text: extracted.slice(0, MAX_RESUME_TEXT_LENGTH),
          subject: subject.slice(0, 200),
          rfcId: /^<[^<>\s]+@[^<>\s]+>$/.test(header("message-id"))
            ? header("message-id")
            : "",
        });
        emails.add(email);
        hashes.add(hash);
        threads.add(message.threadId);
      } catch {
        skip("Failed to read resume. Check the attachment and retry.");
      }
    }
  } finally {
    await imageText.close();
  }
  const id = crypto.randomUUID();
  await transaction(async (tx) => {
    await putRecord(
      tx,
      "import_previews",
      id,
      seal(
        { actor: user.email, expiresAt: Date.now() + 15 * 60000, rows, issues },
        config().encryptionKey,
      ),
    );
    await audit(tx, user.email, "Gmail import preview", undefined, {
      eligible: rows.length,
      skipped: issues.length,
    });
  });
  return {
    id,
    rows: rows.map(({ data, text, ...r }) => r),
    issues,
    scanned: messages.length,
  };
}
export async function confirmImport(
  user: User,
  id: string,
  selections: { messageId: string; name: string; hiringNeedId: string }[],
  confirmed: boolean,
) {
  if (!confirmed) throw new SafeError("Confirm the import first.");
  if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
    throw new SafeError("Recruitment manager access required.", 403);
  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "import_previews", id);
    if (!encrypted)
      throw new SafeError("Preview expired. Preview Gmail again.", 409);
    const preview = unseal<Preview>(encrypted, config().encryptionKey);
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
    if (
      state.applications.length + selections.length >
      (state.importLimit || 100)
    )
      throw new SafeError("Applicant import limit reached.", 409);
    let imported = 0;
    const issues = [...preview.issues];
    for (const selection of selections) {
      const r = preview.rows.find((r) => r.messageId === selection.messageId),
        need = state.hiringNeeds.find(
          (n) => n.id === selection.hiringNeedId && n.status === "Open",
        );
      if (!r || !need || !selection.name.trim() || selection.name.length > 200)
        throw new SafeError(
          "Map every selected applicant to an active hiring need and verify their name.",
        );
      if (
        state.applications.some(
          (a) =>
            a.gmailMessageId === r.messageId ||
            a.gmailThreadId === r.threadId ||
            a.resumeHash === r.hash ||
            a.applicant.email === r.email,
        )
      ) {
        issues.push({
          message: r.subject,
          reason: "Duplicate found at confirmation; skipped.",
        });
        continue;
      }
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
      const a: Application = {
        id: applicationId,
        applicant: {
          id: crypto.randomUUID(),
          name: selection.name.trim(),
          email: r.email,
          phone: "",
          location: "Not verified",
          experience: 0,
        },
        position: need.position,
        location: need.location,
        hiringNeedId: need.id,
        appliedAt: r.receivedAt,
        stage: "Screening",
        status: "New",
        screening: {
          outcome: "Requires Review",
          completedAt: "",
          insight: resumeScreeningInsight(r.text, r.mime, need.criteria || []),
          criteria: screenResumeAgainstCriteria(r.text, need.criteria || []),
        },
        lastActivity: now,
        notes: [],
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
        source: "Gmail",
        assignedTo: user.email,
        onboardingStatus: "Pending Orientation",
      };
      state.applications.push(a);
      await audit(tx, user.email, "application.imported", a.id, {
        messageId: r.messageId,
        threadId: r.threadId,
      });
      imported++;
    }
    preview.used = true;
    await putRecord(
      tx,
      "import_previews",
      id,
      seal({ ...preview, rows: [] }, config().encryptionKey),
    );
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
