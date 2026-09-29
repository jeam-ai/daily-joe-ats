import { requireOrigin, requireUser } from "@/lib/auth/session";
import {
  saveHiringNeed,
  setRealHiringNeedsOpeningDate,
} from "@/lib/server/hiring-needs";
import { safeError } from "@/lib/server/response";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const hiringNeed = await saveHiringNeed(await request.json(), user);
    return Response.json({
      hiringNeed,
      syncStatus: hiringNeed.isDemo
        ? "Demo isolated"
        : "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const hiringNeed = await saveHiringNeed(await request.json(), user);
    return Response.json({
      hiringNeed,
      syncStatus: hiringNeed.isDemo
        ? "Demo isolated"
        : "Changes saved to the ATS database.",
    });
  } catch (error) {
    return safeError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    const result = await setRealHiringNeedsOpeningDate(
      await request.json(),
      user,
    );
    return Response.json(result);
  } catch (error) {
    return safeError(error);
  }
}
