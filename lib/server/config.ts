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
  const origin = new URL(e.APP_ORIGIN!);
  if (
    origin.origin !== e.APP_ORIGIN ||
    new URL(e.GOOGLE_REDIRECT_URI!).origin !== origin.origin
  )
    throw new SafeError(
      "OAuth redirect and application origin must match.",
      503,
    );
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
    redirectUri: e.GOOGLE_REDIRECT_URI!,
    allowedEmail: e.GOOGLE_ALLOWED_EMAIL!.toLowerCase(),
    testRecipient: e.TEST_RECIPIENT_EMAIL?.toLowerCase(),
    sessionSecret: e.SESSION_SECRET!,
    encryptionKey: e.TOKEN_ENCRYPTION_KEY!,
    origin: origin.origin,
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
