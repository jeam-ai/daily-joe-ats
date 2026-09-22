import { createHash } from "node:crypto";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { seal, unseal } from "@/lib/auth/security";
import { canEdit } from "@/lib/data-policy";
import { config, SafeError } from "@/lib/server/config";
import { readTransaction, retryableTransaction } from "@/lib/server/database";
import { safeError } from "@/lib/server/response";
import { audit, getState, saveState } from "@/lib/server/repository";

export const runtime = "nodejs";
export const maxDuration = 120;
type Context = { params: Promise<{ id: string }> };

function imageType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return { mime: "image/png", extension: "png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { mime: "image/jpeg", extension: "jpg" };
  throw new SafeError("Choose a valid PNG or JPG applicant photo.");
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireUser();
    const { id } = await params;
    return await readTransaction(async (tx) => {
      const application = (await getState(tx)).applications.find(
        (item) => item.id === id && !item.deletedAt,
      );
      if (!application?.applicantPhotoId)
        throw new SafeError("Applicant photo not found.", 404);
      const row = (
        await tx.query("SELECT mime,content FROM resumes WHERE id=$1", [
          application.applicantPhotoId,
        ])
      )[0];
      if (!row) throw new SafeError("Applicant photo not found.", 404);
      const bytes = Buffer.from(
        unseal<string>(String(row.content), config().encryptionKey),
        "base64",
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": String(row.mime),
          "Cache-Control": "private, max-age=3600",
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const form = await request.formData();
    const photo = form.get("photo");
    if (!(photo instanceof File) || !photo.size)
      throw new SafeError("Choose an applicant photo.");
    if (photo.size > 2 * 1024 * 1024)
      throw new SafeError("Applicant photo must be 2 MB or smaller.");
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const type = imageType(bytes);
    await retryableTransaction(async (tx) => {
      const state = await getState(tx);
      const application = state.applications.find(
        (item) => item.id === id && !item.deletedAt,
      );
      if (!application) throw new SafeError("Applicant not found.", 404);
      if (!canEdit(user, application))
        throw new SafeError("You cannot edit this applicant.", 403);
      const previous = application.applicantPhotoId;
      const photoId = crypto.randomUUID();
      await tx.query(
        "INSERT INTO resumes(id,sha256,filename,mime,content,extracted_text) VALUES($1,$2,$3,$4,$5,$6)",
        [
          photoId,
          createHash("sha256").update(id).update(bytes).digest("hex"),
          `applicant-photo.${type.extension}`,
          type.mime,
          seal(Buffer.from(bytes).toString("base64"), config().encryptionKey),
          seal("", config().encryptionKey),
        ],
      );
      application.applicantPhotoId = photoId;
      application.applicantPhotoVersion = new Date().toISOString();
      application.editedBy = user.email;
      application.editedAt = application.applicantPhotoVersion;
      application.timeline.push({
        id: crypto.randomUUID(),
        applicationId: id,
        timestamp: application.applicantPhotoVersion,
        user: user.email,
        action: previous ? "Applicant photo replaced" : "Applicant photo added",
        metadata: { note: "Optional profile photo updated by authorized HR." },
      });
      await audit(
        tx,
        user.email,
        previous ? "applicant.photo_replaced" : "applicant.photo_added",
        id,
      );
      if (previous)
        await tx.query("DELETE FROM resumes WHERE id=$1", [previous]);
      await saveState(tx, state, { sync: false });
    });
    return Response.json({ message: "Applicant photo saved." });
  } catch (error) {
    return safeError(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    await retryableTransaction(async (tx) => {
      const state = await getState(tx);
      const application = state.applications.find(
        (item) => item.id === id && !item.deletedAt,
      );
      if (!application) throw new SafeError("Applicant not found.", 404);
      if (!canEdit(user, application))
        throw new SafeError("You cannot edit this applicant.", 403);
      if (!application.applicantPhotoId) return;
      const photoId = application.applicantPhotoId;
      delete application.applicantPhotoId;
      delete application.applicantPhotoVersion;
      application.editedBy = user.email;
      application.editedAt = new Date().toISOString();
      application.timeline.push({
        id: crypto.randomUUID(),
        applicationId: id,
        timestamp: application.editedAt,
        user: user.email,
        action: "Applicant photo removed",
        metadata: { note: "Profile returned to initials." },
      });
      await audit(tx, user.email, "applicant.photo_removed", id);
      await tx.query("DELETE FROM resumes WHERE id=$1", [photoId]);
      await saveState(tx, state, { sync: false });
    });
    return Response.json({ message: "Applicant photo removed." });
  } catch (error) {
    return safeError(error);
  }
}
