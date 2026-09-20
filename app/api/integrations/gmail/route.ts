import { accessToken } from "@/lib/google/gmail/service";
import { gmail } from "@/lib/google/gmail/intake";
import { NextResponse } from "next/server";
import { currentUser, requireUser, requireOrigin } from "@/lib/auth/session";
import { config, SafeError } from "@/lib/server/config";
import { withStore, recordEvent } from "@/lib/server/store";
import { safeError } from "@/lib/server/response";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const c = config();
    const user = await currentUser();
    if (!user)
      return NextResponse.json(
        { connected: false, authenticated: false, configured: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    const official = await withStore((s) => s.officialConnection, false);
    let verified = false,
      requiresReconnect = false,
      officialError = "";
    if (official) {
      try {
        const token = await accessToken(official);
        const profile = await gmail<{ emailAddress: string }>(token, "profile");
        verified = profile.emailAddress.toLowerCase() === c.officialEmail;
        if (!verified)
          officialError =
            "The connected mailbox does not match the official account.";
      } catch (e) {
        officialError =
          e instanceof SafeError
            ? e.message
            : "Gmail connection could not be checked. Try again.";
        requiresReconnect =
          e instanceof SafeError && [401, 403].includes(e.status);
      }
    }
    return NextResponse.json(
      await withStore(
        (s) => ({
          connected: s.connection?.email === user.email,
          email:
            s.connection?.email === user.email ? s.connection.email : undefined,
          connectedAt:
            s.connection?.email === user.email
              ? s.connection.connectedAt
              : undefined,
          authenticated: true,
          configured: true,
          testRecipient: user.email,
          officialEmail: c.officialEmail,
          officialConnected: verified,
          officialStored: !!official,
          requiresReconnect,
          officialError,
          intakeAuthorized:
            s.officialConnection?.scopes?.includes(
              "https://www.googleapis.com/auth/gmail.readonly",
            ) || false,
          sheetsConfigured: !!process.env.GOOGLE_SHEETS_ID,
          sheetsConnected: !!s.sheetsConnection,
          events: s.events
            .filter(
              (event) => event.user === user.email || user.role === "Admin",
            )
            .slice(-20)
            .reverse(),
        }),
        false,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
export async function DELETE(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
      throw new SafeError("Your role cannot disconnect integrations.", 403);
    const kind = new URL(request.url).searchParams.get("kind");
    await withStore((s) => {
      if (kind === "official") delete s.officialConnection;
      else if (kind === "sheets") delete s.sheetsConnection;
      else if (s.connection?.email === user.email) delete s.connection;
      recordEvent(s, user.email, "gmail.disconnected", {
        revocation:
          "Local authorization removed; Google account grant remains until revoked in Google settings.",
      });
    });
    return NextResponse.json({ disconnected: true });
  } catch (e) {
    return safeError(e);
  }
}
