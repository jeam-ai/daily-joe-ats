export const DEFAULT_SUBJECT = "Daily Joe Careers — Gmail Integration Test";
export const DEFAULT_BODY =
  "Hello,\n\nThis is a test email sent from the Daily Joe Careers recruitment system.\n\nIf you received this message, the Gmail integration is working correctly.\n\n— Daily Joe Careers";
export function validEmail(value: string) {
  return (
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
      value,
    ) &&
    !/[\r\n]/.test(value)
  );
}
export function validateEmailInput(
  input: unknown,
  allowedRecipient?: string,
): { to: string; subject: string; body: string } {
  if (!input || typeof input !== "object")
    throw new Error("Provide recipient, subject, and message.");
  const { to, subject, body } = input as Record<string, unknown>;
  if (typeof to !== "string" || !validEmail(to.trim()))
    throw new Error("Enter a valid recipient email address.");
  if (
    !allowedRecipient ||
    to.trim().toLowerCase() !== allowedRecipient.toLowerCase()
  )
    throw new Error("The recipient must match the configured test recipient.");
  if (
    typeof subject !== "string" ||
    !subject.trim() ||
    subject.length > 200 ||
    /[\r\n]/.test(subject)
  )
    throw new Error("Enter a subject of 1–200 characters without line breaks.");
  if (typeof body !== "string" || !body.trim() || body.length > 10000)
    throw new Error("Enter a message of 1–10,000 characters.");
  return { to: to.trim().toLowerCase(), subject: subject.trim(), body };
}
export function buildEmailPayload(input: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}) {
  if (!validEmail(input.to) || /[\r\n]/.test(input.subject))
    throw new Error("Invalid email headers.");
  if (
    input.inReplyTo &&
    (!/^<[^<>\s]+@[^<>\s]+>$/.test(input.inReplyTo) ||
      input.inReplyTo.length > 998)
  )
    throw new Error("Invalid reply headers.");
  const subject = Buffer.from(input.subject).toString("base64");
  const body =
    Buffer.from(input.body.replace(/\r?\n/g, "\r\n"))
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  const mime = [
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
  return {
    raw: Buffer.from(mime).toString("base64url"),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}
