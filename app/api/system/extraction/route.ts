import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
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
    await requireUser();
    const data = await extractionStatus(),
      applicant = new URL(request.url).searchParams.get("applicant");
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
