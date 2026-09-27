import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { reportIssue } from "@/lib/server/diagnostics";
import { isDatabaseFailure } from "@/lib/server/diagnostic-buffer";
import {
  intakeStatus,
  restartQueuedIntake,
  syncIntake,
} from "@/lib/google/gmail/sync";
import { syncGmailThreadActivity } from "@/lib/google/gmail/activity";
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
    // Status reads must not turn a brief Aiven connection interruption into a
    // browser-level 500. The intake job and its Gmail cursor are durable, so
    // returning a retrying status lets the client poll again without claiming
    // that applicant data changed or was lost.
    if (isDatabaseFailure(e))
      return Response.json(
        {
          status: "checking",
          message:
            "Database connection is retrying. The saved Gmail queue is unchanged and will resume automatically.",
          imported: 0,
          checked: 0,
          pending: [],
          issues: [],
          retryAt: Date.now() + 30000,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    return safeError(e);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const reset = url.searchParams.get("reset") === "1";
    if ((await intakeStatus()).status === "paused")
      return Response.json({
        queued: false,
        message:
          "Gmail intake is paused. Resume it in Settings before importing applications.",
      });
    const resetJob = reset ? await restartQueuedIntake(user) : undefined;
    after(async () => {
      const started = Date.now();
      // Thread replies must not wait behind a long application-import backlog.
      const activity = syncGmailThreadActivity().catch(() =>
        reportIssue("gmail.sync"),
      );
      // Gmail sync is deliberately small and resumable. A later poll takes
      // the next durable slice, which is more reliable than one long task in
      // a serverless `after` lifecycle.
      const intake = await syncIntake(user, force, 75000).catch(async () => {
        await reportIssue("gmail.sync");
        return undefined;
      });
      await activity;
      // The deterministic parser runs for every intake. Ask Gemini only once
      // after a real new import, never for a browser status read or an empty
      // mailbox check; its provider quota must not compete with Gmail intake.
      if (intake?.imported && Date.now() - started < 85000)
        await runExtractionJobs(1).catch(() => reportIssue("ai.provider"));
      if (Date.now() - started < 100000)
        await drainEmailOutbox(1).catch(() =>
          reportIssue("notification.failed"),
        );
    });
    return Response.json(
      { queued: true, reset: !!resetJob, job: resetJob },
      { status: 202 },
    );
  } catch (e) {
    return safeError(e);
  }
}
import { runExtractionJobs } from "@/lib/server/ai-extraction";
