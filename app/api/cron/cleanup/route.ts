import {
  retentionDryRunEnabled,
  runRetentionCleanup,
} from "@/lib/server/retention";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  return Response.json(
    await runRetentionCleanup({ dryRun: retentionDryRunEnabled() }),
  );
}
