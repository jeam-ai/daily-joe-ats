import "server-only";
import { createHash } from "node:crypto";
import { unseal } from "@/lib/auth/security";
import { accessToken } from "@/lib/google/gmail/service";
import { gmail, official } from "@/lib/google/gmail/intake";
import { config, SafeError } from "./config";
import { detectResumeType } from "./documents";

type StoredResume = Record<string, unknown>;
type ResumeSource = Record<string, unknown> | null;
type GmailPart = {
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export async function loadResumeBytes(
  row: StoredResume,
  source: ResumeSource,
  dependencies: {
    token?: () => Promise<string>;
    fetchGmail?: (token: string, path: string) => Promise<unknown>;
  } = {},
): Promise<Buffer> {
  let bytes: Buffer;
  const filename = String(row.filename || "");
  if (row.content)
    bytes = Buffer.from(
      unseal<string>(String(row.content), config().encryptionKey),
      "base64",
    );
  else if (source?.provider === "gmail" && source.gmail_message_id) {
    const token = await (
      dependencies.token || (async () => accessToken(await official()))
    )();
    const fetchGmail = dependencies.fetchGmail || gmail;
    const messageId = encodeURIComponent(String(source.gmail_message_id));
    let data: string | undefined;
    if (source.gmail_attachment_id) {
      const attachment = (await fetchGmail(
        token,
        `messages/${messageId}/attachments/${encodeURIComponent(String(source.gmail_attachment_id))}`,
      )) as { data?: string };
      data = attachment.data;
    } else {
      const message = (await fetchGmail(
        token,
        `messages/${messageId}?format=full`,
      )) as {
        payload?: GmailPart;
      };
      const pending = message.payload ? [message.payload] : [];
      while (pending.length && !data) {
        const part = pending.pop()!;
        if (part.filename === filename) {
          data = part.body?.data;
          if (!data && part.body?.attachmentId) {
            const attachment = (await fetchGmail(
              token,
              `messages/${messageId}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
            )) as { data?: string };
            data = attachment.data;
          }
        }
        pending.push(...(part.parts || []));
      }
    }
    if (!data)
      throw new SafeError("The original Gmail attachment was not found.", 404);
    bytes = Buffer.from(data, "base64url");
  } else
    throw new SafeError(
      "The original resume is not available from its retained source. Reconnect Gmail or request the document again.",
      409,
    );
  detectResumeType(bytes, filename);
  if (createHash("sha256").update(bytes).digest("hex") !== String(row.sha256))
    throw new SafeError(
      "The original resume no longer matches the saved reference. No applicant information was changed.",
      409,
    );
  return bytes;
}
