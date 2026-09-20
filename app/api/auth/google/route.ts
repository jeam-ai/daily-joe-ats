import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { config, gmailScope, SafeError } from "@/lib/server/config";
import { createState, seal } from "@/lib/auth/security";
import { currentUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { storageOAuthConfig } from "@/lib/server/storage-oauth";
export async function GET(request: Request) {
  try {
    const kind = new URL(request.url).searchParams.get("flow") || "login";
    const storage = kind === "storage";
    const c = storage ? storageOAuthConfig() : config();
    const gmail = ["gmail", "intake", "official", "sheets", "storage"].includes(
      kind,
    );
    const user = await currentUser();
    if (storage && user?.role !== "Admin")
      throw new SafeError("An administrator must connect storage.", 403);
    if (
      gmail &&
      user &&
      !["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role)
    )
      throw new SafeError("Your role cannot connect integrations.", 403);
    if (gmail && !(await currentUser()))
      return NextResponse.redirect(new URL("/login?error=signin", c.origin));
    const state = createState();
    const verifier = createState();
    const nonce = createState();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      scope: storage
        ? "openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive"
        : kind === "sheets"
          ? "openid email profile https://www.googleapis.com/auth/spreadsheets"
          : gmail
            ? `openid email profile ${gmailScope}${["intake", "official"].includes(kind) ? " https://www.googleapis.com/auth/gmail.readonly" : ""}`
            : "openid email profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      include_granted_scopes: storage ? "false" : "true",
      access_type: gmail ? "offline" : "online",
      prompt: gmail ? "consent" : "select_account",
      login_hint: ["intake", "official", "sheets", "storage"].includes(kind)
        ? c.officialEmail
        : user?.email || c.allowedEmail,
    }).toString();
    const response = NextResponse.redirect(url);
    response.cookies.set(
      "dj_oauth",
      seal(
        {
          state,
          verifier,
          nonce,
          gmail,
          kind,
          actor: user?.email,
          expiresAt: Date.now() + 600000,
        },
        c.encryptionKey,
      ),
      {
        httpOnly: true,
        secure: c.secure,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: 600,
      },
    );
    return response;
  } catch (e) {
    return safeError(e);
  }
}
