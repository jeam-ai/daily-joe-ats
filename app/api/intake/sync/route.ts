import { requireUser, requireOrigin } from "@/lib/auth/session";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { isDatabaseFailure } from "@/lib/server/diagnostic-buffer";
import { intakeStatus } from "@/lib/google/gmail/intake-status";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET() {
  try {
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    return Response.json(await intakeStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Status reads must not turn a brief Aiven connection interruption into a
    // browser-level 500. The intake job and its Gmail cursor are durable, so
    // returning a retrying status lets the client poll again without claiming
    // that applicant data changed or was lost.
    if (isDatabaseFailure(e))
      return Response.json(
        {
          status: "checking",
          message:
            "Database connection is retrying. The saved Gmail queue is unchanged and will resume automatically.",
          imported: 0,
          checked: 0,
          pending: [],
          issues: [],
          retryAt: Date.now() + 30000,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    return safeError(e);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManage(user))
      throw new SafeError("Recruitment manager access required.", 403);
    throw new SafeError(
      "Use the current Sync Now control to start Gmail intake.",
      410,
    );
  } catch (e) {
    return safeError(e);
  }
}
