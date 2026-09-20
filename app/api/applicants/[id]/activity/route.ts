import { requireOrigin, requireUser } from "@/lib/auth/session";
import { transaction, readRecord, putRecord } from "@/lib/server/database";
import { getState, audit } from "@/lib/server/repository";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireOrigin(request);
    const user = await requireUser(),
      { id } = await params;
    await transaction(async (tx) => {
      const a = (await getState(tx)).applications.find(
        (v) => v.id === id && !v.deletedAt,
      );
      if (!a) throw new SafeError("Applicant not found.", 404);
      const key = `${user.id}:${id}`,
        last = await readRecord<number>(tx, "view_activity", key);
      if (last && Date.now() - last < 15 * 60000) return;
      await audit(tx, user.email, "application.viewed", id, {
        name: a.applicant.name,
        email: a.applicant.email,
      });
      await putRecord(tx, "view_activity", key, Date.now());
    });
    return Response.json({ recorded: true });
  } catch (e) {
    return safeError(e);
  }
}
