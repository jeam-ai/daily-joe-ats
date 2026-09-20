export interface EmailRecord {
  id: string;
  applicationId: string;
  actor: string;
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  templateId: string;
  templateName: string;
  templateVersion: string;
  workflow: string;
  status: "Queued" | "Sending" | "Sent" | "Failed" | "Unconfirmed";
  createdAt: string;
  sentAt?: string;
  messageId?: string;
  threadId?: string;
  rfcMessageId: string;
  attempts: number;
  leaseUntil?: number;
  error?: string;
  errorCode?: string;
  sourceFingerprint: string;
  replyThreadId?: string;
  inReplyTo?: string;
}
