import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { reportIssue } from "@/lib/server/diagnostics";
import { intakeStatus, syncIntake } from "@/lib/google/gmail/sync";
export const runtime = "nodejs";
export const maxDuration = 240;
export async function GET() {
  try {
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    return Response.json(await intakeStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    const force = new URL(request.url).searchParams.get("force") === "1";
    after(async () => {
      const started = Date.now();
      await syncIntake(user, force, 140000).catch(() =>
        reportIssue("gmail.sync"),
      );
      if (Date.now() - started < 150000)
        await runExtractionJobs(1).catch(() => reportIssue("ai.provider"));
      if (Date.now() - started < 180000)
        await drainEmailOutbox(1).catch(() =>
          reportIssue("notification.failed"),
        );
    });
    return Response.json({ queued: true }, { status: 202 });
  } catch (e) {
    return safeError(e);
  }
}
