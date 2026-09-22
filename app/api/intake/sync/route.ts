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
export const maxDuration = 120;
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
    if ((await intakeStatus()).status === "paused")
      return Response.json({
        queued: false,
        message:
          "Gmail intake is paused. Resume it in Settings before importing applications.",
      });
    after(async () => {
      const started = Date.now();
      // Gmail sync is deliberately small and resumable. A later poll takes
      // the next durable slice, which is more reliable than one long task in
      // a serverless `after` lifecycle.
      await syncIntake(user, force, 75000).catch(() =>
        reportIssue("gmail.sync"),
      );
      if (Date.now() - started < 85000)
        await runExtractionJobs(1).catch(() => reportIssue("ai.provider"));
      if (Date.now() - started < 100000)
        await drainEmailOutbox(1).catch(() =>
          reportIssue("notification.failed"),
        );
    });
    return Response.json({ queued: true }, { status: 202 });
  } catch (e) {
    return safeError(e);
  }
}
