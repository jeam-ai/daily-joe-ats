import "server-only";
import { initializeGoogleClient } from "../client";
import { config, SafeError, gmailScope } from "@/lib/server/config";
import { withStore, type StoredConnection } from "@/lib/server/store";
import { buildEmailPayload } from "./payload";
export function createGoogleClient() {
  return initializeGoogleClient(config());
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
      const { credentials } = await client.refreshAccessToken();
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
    } catch {
      throw new SafeError(
        "Gmail authorization expired or was revoked. Reconnect Gmail.",
        401,
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
  },
  connection: StoredConnection,
) {
  const token = await accessToken(connection);
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
        body: JSON.stringify(buildEmailPayload(input)),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new SafeError(
      "Gmail did not return a confirmation. Check Sent mail before trying again; the message may have been sent.",
      502,
    );
  }
  if (!response.ok) {
    if (response.status === 401)
      throw new SafeError("Gmail authorization expired. Reconnect Gmail.", 401);
    if (response.status === 403)
      throw new SafeError(
        "Gmail denied sending. Enable Gmail API and grant the gmail.send permission, then reconnect.",
        403,
      );
    if (response.status === 429)
      throw new SafeError(
        "Gmail is rate limiting requests. Wait before trying again.",
        429,
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
// Future: read/search/thread/attachment/reply/label services require a separately
// reviewed scope upgrade. No intake service or background email job exists here.
export { gmailScope };
