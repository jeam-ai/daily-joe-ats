import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { reportIssue } from "@/lib/server/diagnostics";
import {
  recoverOneDeferredDocument,
  refreshStoredEvidenceBatch,
} from "@/lib/server/document-recovery";
import { timingSafeEqual } from "node:crypto";
import { syncIntake, intakeStatus } from "@/lib/google/gmail/sync";
import { syncGmailThreadActivity } from "@/lib/google/gmail/activity";
export const runtime = "nodejs";
export const maxDuration = 240;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const expected = Buffer.from(`Bearer ${secret || ""}`),
    actual = Buffer.from(request.headers.get("authorization") || "");
  if (
    !secret ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  await drainEmailOutbox();
  const started = Date.now();
  const activity = syncGmailThreadActivity().catch(() =>
    reportIssue("gmail.sync"),
  );
  // One durable batch per scheduler invocation. The sync itself records a
  // one-minute cooldown; a scheduler must never force through it and create
  // concurrent Aiven writes.
  await syncIntake(undefined, false, 210000 - (Date.now() - started));
  await activity;
  if (Date.now() - started < 90000) await recoverOneDeferredDocument();
  if (Date.now() - started < 150000)
    await refreshStoredEvidenceBatch(25).catch(() =>
      reportIssue("documents.extraction"),
    );
  if (Date.now() - started < 170000) await runExtractionJobs(1);
  return Response.json({ checked: true });
}
