import { after } from "next/server";
import { syncIntake } from "@/lib/google/gmail/sync";
import { requireUser, requireOrigin } from "@/lib/auth/session";
import {
  publicState,
  updateState,
  updatePreferences,
} from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { syncSheets } from "@/lib/google/sheets";
export const runtime = "nodejs";
export const maxDuration = 240;
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
    const state = await updateState(
      body.state,
      user,
      body.confirmed === true,
      body.dataset === "demo" ? "demo" : "real",
    );
    if (body.dataset !== "demo") after(() => syncIntake(user));
    if (state.syncStatus === "pending") state.syncStatus = await syncSheets();
    return Response.json(state);
  } catch (e) {
    return safeError(e);
  }
}
export async function PATCH(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const raw = await request.text();
    if (raw.length > 8000)
      throw new SafeError("Preference update is too large.");
    const body = JSON.parse(raw);
    return Response.json(
      await updatePreferences(
        body.preferences,
        user,
        body.intakeQuery,
        body.dataset === "demo" ? "demo" : "real",
        body.intakePaused,
      ),
    );
  } catch (e) {
    return safeError(e);
  }
}
