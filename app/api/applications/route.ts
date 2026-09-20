import { requireUser } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { listApplications } from "@/lib/server/application-list";
import { demoEnabled, SafeError } from "@/lib/server/config";
export async function GET(req: Request) {
  try {
    await requireUser();
    const demo = req.headers.get("x-djc-dataset") === "demo";
    if (demo && !demoEnabled())
      throw new SafeError("Demo data is unavailable.", 403);
    return Response.json(
      await listApplications(new URL(req.url).searchParams, demo),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
