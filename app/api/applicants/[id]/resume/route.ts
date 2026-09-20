import { after } from "next/server";
import { queueExtraction, runExtractionJobs } from "@/lib/server/ai-extraction";
import { recordIssue, reportIssue } from "@/lib/server/diagnostics";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { canEdit, canManage } from "@/lib/data-policy";
import { transaction } from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { config, SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { seal, unseal } from "@/lib/auth/security";
import { extractResume } from "@/lib/server/documents";
import { buildInsight, screenResumeAgainstCriteria } from "@/lib/screening";

import { syncSheets } from "@/lib/google/sheets";
export const runtime = "nodejs";
export const maxDuration = 180;
type Context = { params: Promise<{ id: string }> };
export async function GET() {
  try {
    await requireUser();
    return Response.json(
      { systemAnalysis: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(request: Request, { params }: Context) {
  let documentApplicant: string | undefined;
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const snapshot = await transaction(async (tx) => {
      const s = await getState(tx),
        a = s.applications.find((a) => a.id === id && !a.deletedAt);
      if (!a) throw new SafeError("Applicant not found.", 404);
      if (!canEdit(user, a))
        throw new SafeError("You cannot update this applicant.", 403);
      if (a.isDemo)
        throw new SafeError(
          "Demo records use fictional evidence. Resume upload and external AI analysis are disabled.",
          403,
        );
      return {
        a,
        need: s.hiringNeeds.find((n) => n.id === a.hiringNeedId),
        revision: s.revision,
      };
    });
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      if (Number(request.headers.get("content-length")) > 9 * 1024 * 1024)
        throw new SafeError("Resume exceeds the 8 MB limit.");
      const form = await request.formData();
      const file = form.get("resume");
      if (!(file instanceof File) || file.size > 8 * 1024 * 1024)
        throw new SafeError("Choose a resume under 8 MB.");
      const bytes = Buffer.from(await file.arrayBuffer());
      documentApplicant = id;
      const document = await extractResume(bytes, file.name);
      await transaction(async (tx) => {
        const state = await getState(tx),
          a = state.applications.find((v) => v.id === id && !v.deletedAt);
        if (!a || JSON.stringify(a) !== JSON.stringify(snapshot.a))
          throw new SafeError(
            "The applicant changed while reading the resume. Refresh and upload again.",
            409,
          );
        if (a.resumeId)
          throw new SafeError(
            "A resume is already attached. Original source documents are preserved.",
            409,
          );
        if (
          (
            await tx.query("SELECT id FROM resumes WHERE sha256=$1", [
              document.hash,
            ])
          ).length
        )
          throw new SafeError(
            "This resume is already stored. Review the existing applicant to avoid duplicates.",
            409,
          );
        const resumeId = crypto.randomUUID();
        await tx.query(
          "INSERT INTO resumes(id,sha256,filename,mime,content,extracted_text) VALUES($1,$2,$3,$4,$5,$6)",
          [
            resumeId,
            document.hash,
            file.name.slice(0, 200),
            document.mime,
            seal(bytes.toString("base64"), config().encryptionKey),
            seal(document.text, config().encryptionKey),
          ],
        );
        a.resumeId = resumeId;
        a.resumeHash = document.hash;
        a.extraction = document.extraction;
        await queueExtraction(tx, a, user.email);
        const criteria = screenResumeAgainstCriteria(
          document.text,
          snapshot.need?.criteria || [],
          !document.extraction.warnings.length,
        );
        a.screening = {
          criteria,
          completedAt: "",
          outcome: "Requires Review",
          method: "rules",
          insight: buildInsight(
            criteria,
            a.position,
            a.location,
            !!document.text,
          ),
        };
        a.lastActivity = new Date().toISOString();
        a.timeline.push({
          id: crypto.randomUUID(),
          timestamp: a.lastActivity,
          user: user.email,
          action: "Resume uploaded and extracted",
          applicationId: id,
          metadata: {
            method: document.extraction.method,
            warnings: document.extraction.warnings.join(" "),
          },
        });
        await audit(tx, user.email, "resume.uploaded", id, {
          hash: document.hash,
          extraction: document.extraction,
        });
        await audit(tx, user.email, "resume.extraction_completed", id, {
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
        await saveState(tx, state);
      });
      after(() => runExtractionJobs(1));
    } else {
      if (!canManage(user))
        throw new SafeError("A recruitment manager must run screening.", 403);
      const body = await request.json();
      if (body.confirmed !== true)
        throw new SafeError("Confirm the screening action first.");
      if (!snapshot.need?.criteria?.length || !snapshot.a.resumeId)
        throw new SafeError(
          "Assign a hiring need with qualifications and attach a resume first.",
        );
      const resume = await transaction(
        async (tx) =>
          (
            await tx.query("SELECT extracted_text FROM resumes WHERE id=$1", [
              snapshot.a.resumeId,
            ])
          )[0],
      );
      if (!resume) throw new SafeError("Resume not found.", 404);
      const text = unseal<string>(
        String(resume.extracted_text),
        config().encryptionKey,
      );
      const criteria = screenResumeAgainstCriteria(
        text,
        snapshot.need.criteria,
        !snapshot.a.extraction?.warnings.length,
      );
      if (body.ai)
        throw new SafeError(
          "Use the separate AI Assist control. System Analysis is deterministic.",
        );
      const screening = {
        criteria,
        method: "rules" as const,
        completedAt: new Date().toISOString(),
        outcome: "Requires Review" as const,
        insight: buildInsight(
          criteria,
          snapshot.need.position,
          snapshot.need.location,
          !!text,
        ),
      };
      await transaction(async (tx) => {
        const state = await getState(tx),
          a = state.applications.find((v) => v.id === id && !v.deletedAt);
        if (!a || JSON.stringify(a) !== JSON.stringify(snapshot.a))
          throw new SafeError(
            "The workspace changed during analysis. Refresh and review the current applicant before retrying.",
            409,
          );
        await audit(tx, user.email, "screening.updated", id, {
          previous: a.screening,
          next: screening,
        });
        a.screening = screening;
        a.lastActivity = new Date().toISOString();
        a.timeline.push({
          id: crypto.randomUUID(),
          timestamp: a.lastActivity,
          user: user.email,
          action: "System Analysis completed",
          applicationId: id,
          metadata: {
            communication: "HR review required; no recruitment decision made",
          },
        });
        await saveState(tx, state);
      });
    }
    return Response.json({
      message: "Resume evidence saved. HR review is required.",
      syncStatus: await syncSheets(),
    });
  } catch (e) {
    if (documentApplicant && (!(e instanceof SafeError) || e.status !== 409))
      await reportIssue("documents.extraction", {
        entityId: documentApplicant,
      });
    return safeError(e);
  }
}
