import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { syncSheets } from "@/lib/google/sheets";
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const u = await requireUser();
    if (u.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    return Response.json({ message: await syncSheets() });
  } catch (e) {
    return safeError(e);
  }
}
