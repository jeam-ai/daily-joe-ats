import { requireUser } from "@/lib/auth/session";
import { transaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { config, SafeError } from "@/lib/server/config";
import { unseal } from "@/lib/auth/security";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser();
    const { id } = await params;
    return await transaction(async (tx) => {
      const application = (await getState(tx)).applications.find(
        (a) => a.resumeId === id && !a.deletedAt,
      );
      if (!application) throw new SafeError("Resume not found.", 404);
      const rows = await tx.query("SELECT * FROM resumes WHERE id=$1", [id]);
      const row = rows[0];
      if (!row) throw new SafeError("Resume not found.", 404);
      if (new URL(req.url).searchParams.has("text"))
        return Response.json(
          {
            text: unseal<string>(
              String(row.extracted_text),
              config().encryptionKey,
            ),
            filename: row.filename,
            mime: row.mime,
            extraction: application.extraction,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      const mime = String(row.mime);
      return new Response(
        new Uint8Array(
          Buffer.from(
            unseal<string>(String(row.content), config().encryptionKey),
            "base64",
          ),
        ),
        {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `${mime === "application/pdf" || mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "sandbox",
          },
        },
      );
    });
  } catch (e) {
    return safeError(e);
  }
}
