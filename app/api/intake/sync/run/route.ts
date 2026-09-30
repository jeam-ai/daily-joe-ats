import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { reportIssue } from "@/lib/server/diagnostics";
import { restartQueuedIntake, syncIntake } from "@/lib/google/gmail/sync";
import { intakeStatus } from "@/lib/google/gmail/intake-status";
import { syncGmailThreadActivity } from "@/lib/google/gmail/activity";
import { runExtractionJobs } from "@/lib/server/ai-extraction";

export const runtime = "nodejs";
export const maxDuration = 120;
const AUTOMATIC_TRIGGER_INTERVAL_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const reset = url.searchParams.get("reset") === "1";
    const automatic = url.searchParams.get("automatic") === "1";
    const current = await intakeStatus();
    if (current.status === "paused")
      return Response.json({
        queued: false,
        message:
          "Gmail intake is paused. Resume it in Settings before importing applications.",
      });
    // An automatic request is a lightweight nudge from a visible workspace,
    // not a command to rescan Gmail. This durable server guard applies across
    // browsers and devices; Sync Now remains an explicit forced request.
    const lastCompletedAt = current.completedAt
      ? Date.parse(current.completedAt)
      : 0;
    const automaticCooldownActive =
      automatic &&
      ((current.retryAt && current.retryAt > Date.now()) ||
        (lastCompletedAt &&
          Date.now() - lastCompletedAt < AUTOMATIC_TRIGGER_INTERVAL_MS));
    if (automaticCooldownActive)
      return Response.json({
        queued: false,
        deferred: true,
        nextSyncAt:
          current.retryAt || lastCompletedAt + AUTOMATIC_TRIGGER_INTERVAL_MS,
      });
    const resetJob = reset ? await restartQueuedIntake(user) : undefined;
    after(async () => {
      const started = Date.now();
      const activity = syncGmailThreadActivity().catch(() =>
        reportIssue("gmail.sync"),
      );
      const intake = await syncIntake(user, force, 75000).catch(async () => {
        await reportIssue("gmail.sync");
        return undefined;
      });
      await activity;
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
