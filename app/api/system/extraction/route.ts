import { after } from "next/server";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import {
  configureExtraction,
  extractionStatus,
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
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    const body = await req.json();
    if (typeof body.enabled !== "boolean")
      throw new SafeError("Choose whether automatic extraction is enabled.");
    await configureExtraction(body.enabled, user);
    if (body.enabled) after(() => runExtractionJobs());
    return Response.json(await extractionStatus());
  } catch (e) {
    return safeError(e);
  }
}
