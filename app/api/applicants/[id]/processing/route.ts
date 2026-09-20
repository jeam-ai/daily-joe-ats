import { after } from "next/server";
import { queueExtraction, runExtractionJobs } from "@/lib/server/ai-extraction";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { canEdit } from "@/lib/data-policy";
import { transaction, readTransaction } from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { SafeError, config } from "@/lib/server/config";
import { seal, unseal } from "@/lib/auth/security";
import { extractResume } from "@/lib/server/documents";
import { screenResumeAgainstCriteria, buildInsight } from "@/lib/screening";
import {
  recordIssue,
  reportIssue,
  resolveIssue,
} from "@/lib/server/diagnostics";
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
    const snapshot = await readTransaction(async (tx) => {
      const a = (await getState(tx)).applications.find(
        (v) => v.id === id && !v.deletedAt,
      );
      if (!a) throw new SafeError("Applicant not found.", 404);
      if (!canEdit(user, a) || a.isDemo)
        throw new SafeError(
          "Document processing is unavailable for this record or role.",
          403,
        );
      if (!a.resumeId) throw new SafeError("No source resume is attached.");
      const resume = (
        await tx.query("SELECT * FROM resumes WHERE id=$1", [a.resumeId])
      )[0];
      if (!resume) throw new SafeError("Original resume not found.", 404);
      return { a, resume };
    });
    await transaction((tx) =>
      audit(tx, user.email, "resume.processing_requested", id, {
        resumeId: snapshot.a.resumeId,
      }),
    );
    processingStarted = true;
    const document = await extractResume(
      Buffer.from(
        unseal<string>(String(snapshot.resume.content), config().encryptionKey),
        "base64",
      ),
      String(snapshot.resume.filename),
    );
    await transaction(async (tx) => {
      const state = await getState(tx),
        a = state.applications.find((v) => v.id === id && !v.deletedAt);
      if (
        !a ||
        a.resumeId !== snapshot.a.resumeId ||
        JSON.stringify(a.screening) !== JSON.stringify(snapshot.a.screening)
      )
        throw new SafeError(
          "The applicant evidence changed during processing. Refresh before retrying.",
          409,
        );
      await tx.query("UPDATE resumes SET extracted_text=$1 WHERE id=$2", [
        seal(document.text, config().encryptionKey),
        a.resumeId,
      ]);
      a.extraction = document.extraction;
      await queueExtraction(tx, a, user.email);
      if (a.screening.method !== "hr" && !a.screening.completedAt) {
        const rules =
          state.hiringNeeds.find((n) => n.id === a.hiringNeedId)?.criteria ||
          state.qualifications.find((q) => q.position === a.position)?.rules ||
          [];
        const criteria = screenResumeAgainstCriteria(
          document.text,
          rules,
          !document.extraction.warnings.length,
        );
        a.screening = {
          criteria,
          method: "rules",
          completedAt: "",
          outcome: "Requires Review",
          insight: buildInsight(
            criteria,
            a.position,
            a.location,
            !!document.text.trim(),
          ),
        };
      }
      const at = new Date().toISOString();
      a.timeline.push({
        id: crypto.randomUUID(),
        timestamp: at,
        user: user.email,
        action: document.extraction.warnings.length
          ? "Document reprocessed — HR review required"
          : "Document processing completed",
        applicationId: id,
        metadata: {
          method: document.extraction.method,
          warnings: document.extraction.warnings.join(" "),
        },
      });
      await audit(tx, user.email, "resume.processing_completed", id, {
        resumeId: a.resumeId,
        method: document.extraction.method,
        confidence: document.extraction.confidence,
        warnings: document.extraction.warnings.length,
      });
      if (document.extraction.warnings.length)
        await recordIssue(
          "documents.extraction",
          { entityId: id, user: user.email },
          tx,
        );
      await saveState(tx, state, { sync: false });
    });
    if (!document.extraction.warnings.length)
      await resolveIssue("documents.extraction", { entityId: id });
    after(() => runExtractionJobs(1));
    return Response.json({
      message: document.extraction.warnings.length
        ? "Document reprocessed. Some information still requires HR review."
        : "Document processing completed.",
    });
  } catch (e) {
    if (processingStarted && (!(e instanceof SafeError) || e.status !== 409))
      await reportIssue("documents.extraction", { entityId: id });
    return safeError(e);
  }
}
