import { after } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { SafeError } from "@/lib/server/config";
import { recoverApplicationDocument } from "@/lib/server/document-recovery";
import { reportIssue } from "@/lib/server/diagnostics";
import { safeError } from "@/lib/server/response";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let processingStarted = false;
  try {
    requireOrigin(request);
    const user = await requireUser();
    const body = await request.json();
    if (body.confirmed !== true)
      throw new SafeError("Confirm document reprocessing first.");
    processingStarted = true;
    const message = await recoverApplicationDocument(id, user);
    after(() => runExtractionJobs(1));
    return Response.json({ message });
  } catch (error) {
    if (
      processingStarted &&
      (!(error instanceof SafeError) || error.status >= 500)
    )
      await reportIssue("documents.extraction", { entityId: id });
    return safeError(error);
  }
}
