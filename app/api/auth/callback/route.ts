import { after } from "next/server";
import { syncIntake } from "@/lib/google/gmail/sync";
import { NextRequest, NextResponse } from "next/server";
import { config, gmailScope, SafeError } from "@/lib/server/config";
import {
  unseal,
  validateState,
  createState,
  sessionHash,
} from "@/lib/auth/security";
import { SESSION_COOKIE, currentUser } from "@/lib/auth/session";
import { createGoogleClient } from "@/lib/google/gmail/service";
import { recordEvent, withStore } from "@/lib/server/store";
import { findUser } from "@/lib/server/repository";
import { withDeadline } from "@/lib/server/deadline";
import {
  storageGoogleClient,
  storageOAuthConfig,
} from "@/lib/server/storage-oauth";

function providerFailure(error: unknown) {
  if (!error || typeof error !== "object") return "authorization";
  const response = "response" in error ? error.response : undefined;
  if (!response || typeof response !== "object") return "authorization";
  const data = "data" in response ? response.data : undefined;
  if (!data || typeof data !== "object" || !("error" in data))
    return "authorization";
  const code = data.error;
  if (
    code === "invalid_client" ||
    code === "unauthorized_client" ||
    code === "redirect_uri_mismatch"
  )
    return "oauth_config";
  if (code === "invalid_grant") return "oauth_retry";
  return "authorization";
}

function callbackFailure(error: unknown) {
  if (error instanceof SafeError) {
    if (error.message.includes("DATABASE_URL")) return "database";
    if (
      error.message.startsWith("Missing server configuration") ||
      error.message === "Server security keys are not configured correctly."
    )
      return "server_config";
    return error.message;
  }
  return providerFailure(error);
}

function storageFailureCode(error: unknown) {
  if (error instanceof SafeError) {
    if (error.message.includes("authorization needs renewal"))
      return "authorization_renewal";
    if (error.message.includes("authorization could not be verified"))
      return "authorization_response";
    if (error.message.includes("temporarily unavailable"))
      return "gateway_unavailable";
    if (error.message.includes("gateway could not be verified"))
      return "gateway_response";
    if (
      error.message.includes("authenticated transaction gateway") ||
      error.message.includes("gateway address is invalid")
    )
      return "gateway_configuration";
    if (error.message.includes("could not complete this operation"))
      return "gateway_operation";
    return "storage_safe_error";
  }
  if (
    error instanceof DOMException &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    return "timeout";
  if (error instanceof TypeError) return "network";
  return "unexpected";
}

function storageFailureDetails(error: unknown) {
  const details: { reason: string; name?: string; code?: string } = {
    reason: storageFailureCode(error),
  };
  if (!error || typeof error !== "object") return details;
  const candidate = error as Record<string, unknown>;
  for (const key of ["name", "code"] as const) {
    const value = key in candidate ? String(candidate[key]) : "";
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) details[key] = value;
  }
  return details;
}

export const maxDuration = 240;
export async function GET(request: NextRequest) {
  let origin = process.env.APP_ORIGIN || "http://localhost:3000";
  try {
    const c = config();
    origin = c.origin;
    const raw = request.cookies.get("dj_oauth")?.value;
    if (!raw) throw new SafeError("state");
    const flow = unseal<{
      state: string;
      verifier: string;
      nonce: string;
      gmail: boolean;
      kind?: string;
      actor?: string;
      expiresAt: number;
    }>(raw, c.encryptionKey);
    if (
      !validateState(
        request.nextUrl.searchParams.get("state"),
        flow.state,
        flow.expiresAt,
      )
    )
      throw new SafeError("state");
    if (request.nextUrl.searchParams.has("error"))
      throw new SafeError("denied");
    const code = request.nextUrl.searchParams.get("code");
    if (!code) throw new SafeError("authorization");
    const initiator = flow.gmail ? await currentUser() : null;
    if (
      flow.gmail &&
      (!initiator ||
        initiator.email !== flow.actor ||
        !["Admin", "Talent Acquisition", "HR Generalist"].includes(
          initiator.role,
        ))
    )
      throw new SafeError("signin");
    const storage = flow.kind === "storage";
    if (storage && initiator?.role !== "Admin")
      throw new SafeError("unauthorized");
    const client = storage ? storageGoogleClient() : createGoogleClient();
    const { tokens } = await withDeadline(
      client.getToken({
        code,
        codeVerifier: flow.verifier,
        redirect_uri: c.redirectUri,
      }),
      20000,
    );
    if (!tokens.id_token) throw new SafeError("identity");
    const ticket = await withDeadline(
      client.verifyIdToken({
        idToken: tokens.id_token,
        audience: storage ? storageOAuthConfig().clientId : c.clientId,
      }),
      15000,
    );
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    const picture =
      typeof payload?.picture === "string" &&
      /^https:\/\/lh3\.googleusercontent\.com\//.test(payload.picture)
        ? payload.picture
        : undefined;
    let registeredUser;
    try {
      registeredUser = email ? await findUser(email) : undefined;
    } catch (error) {
      // The identity has been verified; failures from this point are storage
      // failures, not Google authorization failures.
      console.error("OAuth storage read failed", storageFailureDetails(error));
      throw new SafeError("database", 503);
    }
    if (!payload?.email_verified || !email || !registeredUser)
      throw new SafeError("unauthorized");
    if (
      ["official", "intake", "sheets", "storage"].includes(flow.kind || "") &&
      email !== c.officialEmail
    )
      throw new SafeError("official_account");
    if (flow.kind === "gmail" && email !== initiator?.email)
      throw new SafeError("unauthorized");
    if ((payload as unknown as { nonce?: string }).nonce !== flow.nonce)
      throw new SafeError("state");
    if (
      flow.gmail &&
      !["sheets", "storage"].includes(flow.kind || "") &&
      (!tokens.access_token || !tokens.scope?.split(" ").includes(gmailScope))
    )
      throw new SafeError("scope");
    if (
      ["intake", "official"].includes(flow.kind || "") &&
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/gmail.readonly")
    )
      throw new SafeError("scope");
    if (
      ["sheets", "storage"].includes(flow.kind || "") &&
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/spreadsheets")
    )
      throw new SafeError("scope");
    if (
      storage &&
      (!tokens.access_token ||
        !tokens.refresh_token ||
        !tokens.scope
          ?.split(" ")
          .includes("https://www.googleapis.com/auth/drive"))
    )
      throw new SafeError("scope");
    const session = createState();
    try {
      await withStore((s) => {
        const old = request.cookies.get(SESSION_COOKIE)?.value;
        if (old) delete s.sessions[sessionHash(old, c.sessionSecret)];
        for (const key of Object.keys(s.sessions))
          if (s.sessions[key].expiresAt < Date.now()) delete s.sessions[key];
        s.sessions[sessionHash(session, c.sessionSecret)] = {
          email: flow.gmail ? initiator!.email : email,
          name: flow.gmail ? initiator!.name : payload.name || email,
          picture: flow.gmail ? initiator!.avatarUrl : picture,
          expiresAt: Date.now() + 8 * 3600000,
        };
        if (flow.gmail) {
          const key = storage
            ? "storageConnection"
            : flow.kind === "sheets"
              ? "sheetsConnection"
              : ["official", "intake"].includes(flow.kind || "")
                ? "officialConnection"
                : "connection";
          s[key] = {
            email,
            accessToken: tokens.access_token!,
            refreshToken:
              tokens.refresh_token ||
              (s[key]?.email === email ? s[key]?.refreshToken : undefined),
            scopes: tokens.scope?.split(" "),
            expiresAt: tokens.expiry_date || Date.now() + 3500000,
            connectedAt: new Date().toISOString(),
            connectedBy: initiator!.email,
          };
          recordEvent(
            s,
            email,
            storage
              ? "storage.connected"
              : flow.kind === "sheets"
                ? "sheets.connected"
                : "gmail.connected",
          );
        }
        recordEvent(s, email, "auth.login");
      });
    } catch (error) {
      console.error("OAuth storage write failed", storageFailureDetails(error));
      throw new SafeError("database", 503);
    }
    const response = NextResponse.redirect(
      new URL(
        storage
          ? "/settings/data?connected=1"
          : flow.gmail
            ? "/settings/integrations?connected=1"
            : "/",
        origin,
      ),
    );
    response.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 3600,
    });
    response.cookies.set("dj_oauth", "", { path: "/api/auth", maxAge: 0 });
    if (!storage)
      after(() => syncIntake(flow.gmail ? initiator! : registeredUser, true));
    return response;
  } catch (e) {
    const code = callbackFailure(e);
    // Keep OAuth codes and tokens out of logs while preserving a useful Vercel
    // diagnostic category for production-only callback failures.
    console.error("OAuth callback failed", { category: code });
    const response = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(code)}`, origin),
    );
    response.cookies.set("dj_oauth", "", { path: "/api/auth", maxAge: 0 });
    return response;
  }
}
