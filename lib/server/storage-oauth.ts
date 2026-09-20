import "server-only";
import { initializeGoogleClient } from "@/lib/google/client";
import { config, SafeError } from "./config";

// Storage can use a separate organization-owned Cloud project. It must not
// replace the established sign-in/Gmail client or mix their refresh tokens.
export function storageOAuthConfig() {
  const c = config();
  const clientId = process.env.SHEETS_GATEWAY_CLIENT_ID || c.clientId;
  const clientSecret =
    process.env.SHEETS_GATEWAY_CLIENT_SECRET || c.clientSecret;
  if (
    !!process.env.SHEETS_GATEWAY_CLIENT_ID !==
    !!process.env.SHEETS_GATEWAY_CLIENT_SECRET
  )
    throw new SafeError(
      "Configure both storage OAuth client variables before connecting private storage.",
      503,
    );
  return { ...c, clientId, clientSecret };
}
export function storageGoogleClient() {
  return initializeGoogleClient(storageOAuthConfig());
}
