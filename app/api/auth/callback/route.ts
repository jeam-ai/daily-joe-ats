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
    const client = createGoogleClient();
    const { tokens } = await client.getToken({
      code,
      codeVerifier: flow.verifier,
      redirect_uri: c.redirectUri,
    });
    if (!tokens.id_token) throw new SafeError("identity");
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: c.clientId,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    const picture =
      typeof payload?.picture === "string" &&
      /^https:\/\/lh3\.googleusercontent\.com\//.test(payload.picture)
        ? payload.picture
        : undefined;
    if (!payload?.email_verified || !email || !(await findUser(email)))
      throw new SafeError("unauthorized");
    if (
      ["official", "intake"].includes(flow.kind || "") &&
      email !== c.officialEmail
    )
      throw new SafeError("unauthorized");
    if (flow.kind === "gmail" && email !== initiator?.email)
      throw new SafeError("unauthorized");
    if ((payload as unknown as { nonce?: string }).nonce !== flow.nonce)
      throw new SafeError("state");
    if (
      flow.gmail &&
      flow.kind !== "sheets" &&
      (!tokens.access_token || !tokens.scope?.split(" ").includes(gmailScope))
    )
      throw new SafeError("scope");
    if (
      flow.kind === "intake" &&
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/gmail.readonly")
    )
      throw new SafeError("scope");
    if (
      flow.kind === "sheets" &&
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/spreadsheets")
    )
      throw new SafeError("scope");
    const session = createState();
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
        const key =
          flow.kind === "sheets"
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
        };
        recordEvent(s, email, "gmail.connected");
      }
      recordEvent(s, email, "auth.login");
    });
    const response = NextResponse.redirect(
      new URL(flow.gmail ? "/settings/integrations?connected=1" : "/", origin),
    );
    response.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 3600,
    });
    response.cookies.set("dj_oauth", "", { path: "/api/auth", maxAge: 0 });
    return response;
  } catch (e) {
    const code = e instanceof SafeError ? e.message : providerFailure(e);
    const response = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(code)}`, origin),
    );
    response.cookies.set("dj_oauth", "", { path: "/api/auth", maxAge: 0 });
    return response;
  }
}
