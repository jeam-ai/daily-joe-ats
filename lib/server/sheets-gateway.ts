import "server-only";
import { createHmac } from "node:crypto";
import { SafeError } from "./config";
export const sheetsPrimary = () =>
  process.env.PERSISTENCE_PROVIDER === "sheets";
export function gatewayConfigured() {
  return (
    (!!process.env.SHEETS_GATEWAY_URL ||
      (!!process.env.SHEETS_GATEWAY_DEPLOYMENT_ID &&
        !!process.env.SHEETS_GATEWAY_REFRESH_TOKEN)) &&
    !!process.env.SHEETS_GATEWAY_SECRET
  );
}
let executionToken: { value: string; expiresAt: number } | undefined;
async function gatewayAccessToken() {
  if (executionToken && executionToken.expiresAt > Date.now() + 360000)
    return executionToken.value;
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:
        process.env.SHEETS_GATEWAY_CLIENT_ID ||
        process.env.GOOGLE_CLIENT_ID ||
        "",
      client_secret:
        process.env.SHEETS_GATEWAY_CLIENT_SECRET ||
        process.env.GOOGLE_CLIENT_SECRET ||
        "",
      refresh_token: process.env.SHEETS_GATEWAY_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!result.ok)
    throw new SafeError(
      "Sheets storage authorization needs renewal. Ask an administrator to reconnect its official Google account.",
      503,
    );
  const token = await result.json();
  if (typeof token.access_token !== "string")
    throw new SafeError(
      "Sheets storage authorization could not be verified.",
      503,
    );
  executionToken = {
    value: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3000) * 1000,
  };
  return executionToken.value;
}
export async function gatewayRequest<T>(
  operation: string,
  parameters: Record<string, unknown> = {},
): Promise<T> {
  const deployment = process.env.SHEETS_GATEWAY_DEPLOYMENT_ID;
  const url = deployment
      ? `https://script.googleapis.com/v1/scripts/${deployment}:run`
      : process.env.SHEETS_GATEWAY_URL,
    secret = process.env.SHEETS_GATEWAY_SECRET;
  if (!url || !secret || secret.length < 32)
    throw new SafeError(
      "Sheets persistence requires its authenticated transaction gateway. Complete Data Management setup before cutover.",
      503,
    );
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    (deployment
      ? parsed.hostname !== "script.googleapis.com" ||
        !/^[\w-]+$/.test(deployment)
      : parsed.hostname !== "script.google.com" ||
        !/^\/macros\/s\/[\w-]+\/exec$/.test(parsed.pathname))
  )
    throw new SafeError(
      "The Sheets transaction gateway address is invalid.",
      503,
    );
  // Sign an ASCII JSON representation so the transport/runtime's default
  // string encoding cannot change signatures. JSON.parse restores all Unicode.
  const payload = JSON.stringify({
    operation,
    ...parameters,
    at: Date.now(),
    nonce: crypto.randomUUID(),
  }).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deployment
          ? { Authorization: `Bearer ${await gatewayAccessToken()}` }
          : {}),
      },
      body: JSON.stringify(
        deployment
          ? {
              function: "executeGateway",
              parameters: [{ payload, signature }],
              devMode: false,
            }
          : { payload, signature },
      ),
      // Reads should stay responsive. Atomic commits may include a private
      // document batch, so allow a bounded confirmation window below the
      // server route deadline; same-key receipt retry handles a lost response.
      signal: AbortSignal.timeout(operation === "commit" ? 120000 : 30000),
    });
  } catch {
    throw new SafeError(
      "Google Sheets storage timed out before confirming this operation. Original data remains preserved; refresh before retrying.",
      503,
    );
  }
  if (!r.ok)
    throw new SafeError(
      "Google Sheets storage is temporarily unavailable. Retry after checking System Health.",
      503,
    );
  let result: { ok: boolean; code?: string; data: T };
  try {
    const body = await r.json();
    result = deployment ? body.response?.result : body;
    if (!result) throw Error("Execution response missing");
  } catch {
    throw new SafeError(
      "The Sheets gateway could not be verified. Review its deployment access.",
      503,
    );
  }
  if (!result.ok)
    throw new SafeError(
      result.code === "conflict"
        ? "Another update was saved first. Refresh before retrying; your changes have not overwritten it."
        : result.code === "busy"
          ? "Google Sheets is finishing another operation. Retrying safely."
          : result.code === "unverified"
            ? "The migration has not passed verification. Sheets cutover is blocked."
            : "Sheets storage could not complete this operation. Original data remains preserved. Check System Health.",
      result.code === "conflict" || result.code === "busy" ? 409 : 503,
    );
  return result.data;
}
