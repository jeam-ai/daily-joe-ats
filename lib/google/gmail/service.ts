import "server-only";
import { initializeGoogleClient } from "../client";
import { config, SafeError, gmailScope } from "@/lib/server/config";
import { withStore, type StoredConnection } from "@/lib/server/store";
import { buildEmailPayload } from "./payload";
import { withDeadline } from "@/lib/server/deadline";
export function createGoogleClient() {
  return initializeGoogleClient(config());
}
export class GmailSendError extends SafeError {
  constructor(
    message: string,
    status: number,
    public definitelyNotSent: boolean,
  ) {
    super(message, status);
  }
}
export async function accessToken(connection: StoredConnection) {
  let accessToken = connection.accessToken;
  if (connection.expiresAt < Date.now() + 60000) {
    if (!connection.refreshToken)
      throw new SafeError(
        "Gmail authorization expired. Reconnect Gmail before sending.",
        401,
      );
    const client = createGoogleClient();
    client.setCredentials({ refresh_token: connection.refreshToken });
    try {
      const { credentials } = await withDeadline(
        client.refreshAccessToken(),
        20000,
      );
      if (!credentials.access_token) throw new Error();
      accessToken = credentials.access_token;
      await withStore((s) => {
        for (const key of [
          "connection",
          "officialConnection",
          "sheetsConnection",
        ] as const) {
          const stored = s[key];
          if (
            stored?.email === connection.email &&
            stored.connectedAt === connection.connectedAt
          ) {
            stored.accessToken = accessToken;
            stored.expiresAt = credentials.expiry_date || Date.now() + 3500000;
          }
        }
      });
    } catch (error) {
      const code = (error as { response?: { data?: { error?: string } } })
        .response?.data?.error;
      if (code === "invalid_grant")
        throw new SafeError(
          "Gmail authorization was revoked or expired. Reconnect the official mailbox.",
          401,
        );
      throw new SafeError(
        "Gmail could not refresh the connection. Try again; your saved authorization has been retained.",
        502,
      );
    }
  }
  return accessToken;
}
export async function sendEmail(
  input: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    inReplyTo?: string;
    messageId?: string;
  },
  connection: StoredConnection,
) {
  let token: string;
  try {
    token = await accessToken(connection);
  } catch (e) {
    throw new GmailSendError(
      e instanceof SafeError
        ? e.message
        : "Gmail authorization could not be checked.",
      e instanceof SafeError ? e.status : 502,
      true,
    );
  }
  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildEmailPayload({ ...input, from: connection.email }),
        ),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new GmailSendError(
      "Gmail did not return a confirmation. Check Sent mail before trying again; the message may have been sent.",
      502,
      false,
    );
  }
  if (!response.ok) {
    if (response.status === 401)
      throw new GmailSendError(
        "Gmail authorization expired. Reconnect Gmail.",
        401,
        true,
      );
    if (response.status === 403)
      throw new GmailSendError(
        "Gmail denied sending. Enable Gmail API and grant the gmail.send permission, then reconnect.",
        403,
        true,
      );
    if (response.status === 429)
      throw new GmailSendError(
        "Gmail is rate limiting requests. Wait before trying again.",
        429,
        true,
      );
    throw new SafeError(
      "Gmail could not confirm sending. Check Sent mail before retrying.",
      502,
    );
  }
  const result = await response.json();
  if (!result.id)
    throw new SafeError(
      "Gmail returned an incomplete confirmation. Check Sent mail before retrying.",
      502,
    );
  return {
    messageId: String(result.id),
    threadId: result.threadId ? String(result.threadId) : undefined,
  };
}
// Only explicit HR actions call sendEmail; intake jobs never send messages.
export { gmailScope };
