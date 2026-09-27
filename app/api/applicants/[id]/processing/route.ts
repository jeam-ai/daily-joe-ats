import { after } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { SafeError } from "@/lib/server/config";
import {
  recoverApplicationDocument,
  refreshStoredEvidenceBatch,
} from "@/lib/server/document-recovery";
import { reportIssue } from "@/lib/server/diagnostics";
import { safeError } from "@/lib/server/response";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    requireOrigin(request);
    const user = await requireUser();
    const body = await request.json();
    if (body.refreshStoredEvidence === true) {
      if (!canManage(user))
        throw new SafeError("Recruitment manager access required.", 403);
      const result = await refreshStoredEvidenceBatch(1, id);
      return Response.json(result);
    }
    if (body.confirmed !== true)
      throw new SafeError("Confirm document reprocessing first.");
    const message = await recoverApplicationDocument(id, user);
    after(() => runExtractionJobs(1));
    return Response.json({ message });
  } catch (error) {
    if (!(error instanceof SafeError) || error.status >= 500)
      await reportIssue("documents.extraction", { entityId: id });
    return safeError(error);
  }
}
