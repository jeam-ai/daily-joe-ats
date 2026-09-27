import { requireUser } from "@/lib/auth/session";
import { recentGmailThreadActivity } from "@/lib/google/gmail/activity";
import { safeError } from "@/lib/server/response";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireUser();
    const url = new URL(request.url);
    const applicationId = url.searchParams.get("application") || undefined;
    if (applicationId && !/^[\w-]{1,80}$/.test(applicationId))
      return Response.json(
        { error: "Invalid application ID" },
        { status: 400 },
      );
    const events = await recentGmailThreadActivity(
      applicationId,
      applicationId ? 20 : 5,
    );
    return Response.json(
      { events },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return safeError(error);
  }
}
