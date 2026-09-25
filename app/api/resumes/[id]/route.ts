import { requireUser } from "@/lib/auth/session";
import { readTransaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { config, SafeError } from "@/lib/server/config";
import { unseal } from "@/lib/auth/security";
import { accessToken } from "@/lib/google/gmail/service";
import { gmail, official } from "@/lib/google/gmail/intake";
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
    let bytes: Buffer;
    if (String(resume.row.content || ""))
      bytes = Buffer.from(
        unseal<string>(String(resume.row.content), config().encryptionKey),
        "base64",
      );
    else if (
      resume.source?.provider === "gmail" &&
      resume.source.gmail_message_id
    ) {
      const token = await accessToken(await official());
      if (resume.source.gmail_attachment_id) {
        const attachment = await gmail<{ data: string }>(
          token,
          `messages/${encodeURIComponent(String(resume.source.gmail_message_id))}/attachments/${encodeURIComponent(String(resume.source.gmail_attachment_id))}`,
        );
        bytes = Buffer.from(attachment.data, "base64url");
      } else {
        // Gmail can inline small attachment bodies directly in the message
        // part instead of assigning an attachment id. Resolve that reference
        // on demand so PostgreSQL still does not need to retain the file.
        type Part = {
          filename?: string;
          body?: { data?: string; attachmentId?: string };
          parts?: Part[];
        };
        const message = await gmail<{ payload: Part }>(
          token,
          `messages/${encodeURIComponent(String(resume.source.gmail_message_id))}?format=full`,
        );
        const pending = [message.payload];
        let data: string | undefined;
        while (pending.length && !data) {
          const part = pending.pop()!;
          if (part.filename === String(resume.row.filename)) {
            data = part.body?.data;
            if (!data && part.body?.attachmentId) {
              data = (
                await gmail<{ data: string }>(
                  token,
                  `messages/${encodeURIComponent(String(resume.source.gmail_message_id))}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
                )
              ).data;
            }
          }
          pending.push(...(part.parts || []));
        }
        if (!data)
          throw new SafeError(
            "The original Gmail attachment was not found.",
            404,
          );
        bytes = Buffer.from(data, "base64url");
      }
    } else
      throw new SafeError(
        "The original resume is not available from its retained source. Reconnect Gmail or request the document again.",
        409,
      );
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
