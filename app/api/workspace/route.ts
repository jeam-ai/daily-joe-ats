import { requireUser, requireOrigin } from "@/lib/auth/session";
import { publicState, updateState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { syncSheets } from "@/lib/google/sheets";
export const runtime = "nodejs";
export async function GET() {
  try {
    return Response.json(await publicState(await requireUser()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return safeError(e);
  }
}
export async function PUT(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const raw = await request.text();
    if (raw.length > 4000000)
      throw new SafeError("Workspace update is too large.");
    const body = JSON.parse(raw);
    const state = await updateState(body.state, user, body.confirmed === true);
    state.syncStatus = await syncSheets();
    return Response.json(state);
  } catch (e) {
    return safeError(e);
  }
}
