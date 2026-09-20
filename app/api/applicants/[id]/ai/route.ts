import { requireOrigin, requireUser } from "@/lib/auth/session";
import { aiProfile, runAiAssist, setAiEnabled } from "@/lib/server/ai-assist";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
export const runtime = "nodejs";
export const maxDuration = 90;
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    return Response.json(
      await aiProfile((await params).id, await requireUser()),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    requireOrigin(request);
    const user = await requireUser(),
      { id } = await params,
      body = await request.json();
    if (body.action === "enable" || body.action === "disable")
      await setAiEnabled(id, user, body.action === "enable");
    else if (body.action === "run" && body.confirmed === true)
      await runAiAssist(id, user, body.fresh === true);
    else throw new SafeError("Confirm the AI Assist action first.");
    return Response.json(await aiProfile(id, user));
  } catch (e) {
    return safeError(e);
  }
}
