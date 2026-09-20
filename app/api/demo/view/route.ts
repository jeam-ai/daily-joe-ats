import { requireOrigin, requireUser } from "@/lib/auth/session";
import { transaction } from "@/lib/server/database";
import { audit, getState } from "@/lib/server/repository";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser(),
      body = await request.json();
    if (!["real", "demo"].includes(body.dataset))
      throw new SafeError("Choose a dataset.");
    await transaction(async (tx) => {
      if (
        body.dataset === "demo" &&
        !(await getState(tx)).applications.some((a) => a.isDemo)
      )
        throw new SafeError("Launch demo data first.", 409);
      await audit(
        tx,
        user.email,
        body.dataset === "demo" ? "demo.view_enabled" : "demo.view_disabled",
        undefined,
        { dataset: body.dataset },
      );
    });
    return Response.json({ ok: true });
  } catch (e) {
    return safeError(e);
  }
}
