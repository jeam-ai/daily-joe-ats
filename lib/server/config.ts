import "server-only";
export class SafeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const gmailScope = "https://www.googleapis.com/auth/gmail.send";

export function oauthUrls(appOrigin: string, redirectUri: string) {
  let app: URL;
  let callback: URL;
  try {
    app = new URL(appOrigin);
    callback = new URL(redirectUri);
  } catch {
    throw new SafeError("OAuth URLs must be valid absolute URLs.", 503);
  }
  if (
    !["http:", "https:"].includes(app.protocol) ||
    app.pathname !== "/" ||
    app.search ||
    app.hash ||
    callback.origin !== app.origin ||
    callback.pathname !== "/api/auth/callback" ||
    callback.search ||
    callback.hash
  )
    throw new SafeError(
      "Google OAuth must use this app's /api/auth/callback URL.",
      503,
    );
  return { origin: app.origin, redirectUri: callback.href };
}
export function config() {
  const e = process.env;
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "GOOGLE_ALLOWED_EMAIL",
    "SESSION_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "APP_ORIGIN",
  ] as const;
  const missing = required.filter((k) => !e[k]);
  if (missing.length)
    throw new SafeError(
      `Missing server configuration: ${missing.join(", ")}.`,
      503,
    );
  if (
    e.SESSION_SECRET!.length < 32 ||
    !/^[a-f\d]{64}$/i.test(e.TOKEN_ENCRYPTION_KEY!)
  )
    throw new SafeError(
      "Server security keys are not configured correctly.",
      503,
    );
  const urls = oauthUrls(e.APP_ORIGIN!, e.GOOGLE_REDIRECT_URI!);
  const origin = new URL(urls.origin);
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  )
    throw new SafeError("HTTPS is required outside localhost.", 503);
  return {
    officialEmail: (
      e.OFFICIAL_CAREERS_EMAIL || "careers@daily-joe.com"
    ).toLowerCase(),
    clientId: e.GOOGLE_CLIENT_ID!,
    clientSecret: e.GOOGLE_CLIENT_SECRET!,
    redirectUri: urls.redirectUri,
    allowedEmail: e.GOOGLE_ALLOWED_EMAIL!.toLowerCase(),
    testRecipient: e.TEST_RECIPIENT_EMAIL?.toLowerCase(),
    sessionSecret: e.SESSION_SECRET!,
    encryptionKey: e.TOKEN_ENCRYPTION_KEY!,
    origin: urls.origin,
    secure: origin.protocol === "https:",
  };
}
export function demoEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SOFT_LAUNCH_MODE !== "true" &&
    process.env.DEMO_MODE === "true"
  );
}
