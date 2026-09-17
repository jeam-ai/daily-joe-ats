import { OAuth2Client } from "google-auth-library";
export function initializeGoogleClient(settings: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  if (!settings.clientId || !settings.clientSecret || !settings.redirectUri)
    throw new Error("Google OAuth configuration is incomplete.");
  return new OAuth2Client(
    settings.clientId,
    settings.clientSecret,
    settings.redirectUri,
  );
}
