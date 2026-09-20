import { requireUser, requireOrigin } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { SafeError, demoEnabled } from "@/lib/server/config";
import { transaction } from "@/lib/server/database";
import { clearDemo, launchDemo } from "@/lib/server/demo";
export const runtime = "nodejs";
async function run(request: Request, clear: boolean) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    if (!demoEnabled() && !clear)
      throw new SafeError(
        "Demo generation is disabled on this deployment.",
        403,
      );
    if (clear && (await request.json()).confirmed !== true)
      throw new SafeError("Confirm clearing demo data first.");
    return Response.json(
      await (clear
        ? transaction((tx) => clearDemo(tx, user))
        : transaction((tx) => launchDemo(tx, user))),
    );
  } catch (e) {
    return safeError(e);
  }
}
export const POST = (request: Request) => run(request, false);
export const DELETE = (request: Request) => run(request, true);
