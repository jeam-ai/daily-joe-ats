import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import {
  configureExtraction,
  extractionProvider,
  extractionStatus,
  retryExtraction,
  runExtractionJobs,
} from "@/lib/server/ai-extraction";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const data = await extractionStatus(),
      url = new URL(request.url),
      applicant = url.searchParams.get("applicant"),
      drain = url.searchParams.get("drain") === "1";
    if (drain) {
      if (!canManage(user))
        throw new SafeError("Recruitment manager access required.", 403);
      const ready = data.jobs.some(
        (job) =>
          job.status === "Queued" ||
          (job.status === "Failed" &&
            !!job.retryAt &&
            job.retryAt <= Date.now()),
      );
      if (ready && data.enabled && data.configured)
        after(() => runExtractionJobs(1).catch(() => undefined));
      return Response.json(
        {
          enabled: data.enabled,
          configured: data.configured,
          queued: data.jobs.filter((job) => job.status === "Queued").length,
          running: data.jobs.filter((job) => job.status === "Running").length,
          retryable: data.jobs.filter(
            (job) =>
              job.status === "Failed" &&
              !!job.retryAt &&
              job.retryAt <= Date.now(),
          ).length,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (applicant)
      data.jobs = data.jobs.filter((j) => j.applicationId === applicant);
    if (
      applicant &&
      data.enabled &&
      data.configured &&
      data.jobs.some((job) => ["Queued", "Failed"].includes(job.status))
    )
      after(() =>
        runExtractionJobs(1, extractionProvider(), applicant).catch(
          () => undefined,
        ),
      );
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const user = await requireUser();
    const body = await req.json();
    if (body.retry === true && typeof body.applicationId === "string") {
      await retryExtraction(body.applicationId, user);
      after(() =>
        runExtractionJobs(1, extractionProvider(), body.applicationId).catch(
          () => undefined,
        ),
      );
      return Response.json({ message: "AI fallback retry queued." });
    }
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    if (typeof body.enabled !== "boolean")
      throw new SafeError("Choose whether automatic extraction is enabled.");
    await configureExtraction(body.enabled, user);
    if (body.enabled) after(() => runExtractionJobs());
    return Response.json(await extractionStatus());
  } catch (e) {
    return safeError(e);
  }
}
