import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { drainEmailOutbox } from "@/lib/server/email-outbox";
import { timingSafeEqual } from "node:crypto";
import { syncIntake, intakeStatus } from "@/lib/google/gmail/sync";
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
  for (let i = 0; i < 20 && Date.now() - started < 150000; i++) {
    await syncIntake(undefined, i > 0, 210000 - (Date.now() - started));
    const job = await intakeStatus();
    if (job.status !== "complete" || (!job.pending.length && !job.page)) break;
  }
  if (Date.now() - started < 170000) await runExtractionJobs(1);
  return Response.json({ checked: true });
}
