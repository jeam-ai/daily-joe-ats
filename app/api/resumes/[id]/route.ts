import { requireUser } from "@/lib/auth/session";
import { readTransaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { config, SafeError } from "@/lib/server/config";
import { unseal } from "@/lib/auth/security";
import { loadResumeBytes } from "@/lib/server/resume-source";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser();
    const { id } = await params;
    const resume = await readTransaction(async (tx) => {
      const application = (await getState(tx)).applications.find(
        (a) => a.resumeId === id && !a.deletedAt,
      );
      if (!application) throw new SafeError("Resume not found.", 404);
      const rows = await tx.query("SELECT * FROM resumes WHERE id=$1", [id]);
      const row = rows[0];
      if (!row) throw new SafeError("Resume not found.", 404);
      const source = (
        await tx.query(
          "SELECT provider,gmail_message_id,gmail_attachment_id FROM resume_sources WHERE resume_id=$1",
          [id],
        )
      )[0];
      return { application, row, source };
    });
    if (new URL(req.url).searchParams.has("text"))
      return Response.json(
        {
          text: unseal<string>(
            String(resume.row.extracted_text),
            config().encryptionKey,
          ),
          filename: resume.row.filename,
          mime: resume.row.mime,
          extraction: resume.application.extraction,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    const mime = String(resume.row.mime);
    const bytes = await loadResumeBytes(resume.row, resume.source);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `${mime === "application/pdf" || mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(String(resume.row.filename))}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (e) {
    return safeError(e);
  }
}
