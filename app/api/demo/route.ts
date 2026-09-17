import { requireUser, requireOrigin } from "@/lib/auth/session";
import { safeError } from "@/lib/server/response";
import { SafeError } from "@/lib/server/config";
import { transaction } from "@/lib/server/database";
import { getState, saveState } from "@/lib/server/repository";
import { createSeed } from "@/lib/mock/seed";

export const runtime = "nodejs";

function ensureLocalOnly() {
  if (process.env.NODE_ENV === "production")
    throw new SafeError(
      "Demo data is available only in local development.",
      404,
    );
}

export async function POST(request: Request) {
  try {
    ensureLocalOnly();
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    return transaction(async (tx) => {
      const state = await getState(tx);
      const seed = createSeed();
      const demo = seed.applications.slice(0, 10).map((application, index) => ({
        ...application,
        id: `DEMO-${String(index + 1).padStart(3, "0")}`,
        source: "Demo",
        ...(application.status === "Hired" && !application.employment
          ? {
              employment: {
                status: "Active" as const,
                date: new Date().toISOString().slice(0, 10),
                notes: "Fictional demo record",
                actor: "Demo HR",
              },
            }
          : {}),
      }));
      state.applications = [
        ...state.applications.filter((a) => a.source !== "Demo"),
        ...demo,
      ];
      if (!state.hiringNeeds.length) state.hiringNeeds = seed.hiringNeeds;
      await saveState(tx, state);
      return Response.json({
        imported: demo.length,
        total: state.applications.length,
      });
    });
  } catch (e) {
    return safeError(e);
  }
}

export async function DELETE(request: Request) {
  try {
    ensureLocalOnly();
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    return transaction(async (tx) => {
      const state = await getState(tx);
      const before = state.applications.length;
      state.applications = state.applications.filter(
        (a) => a.source !== "Demo",
      );
      await saveState(tx, state);
      return Response.json({
        removed: before - state.applications.length,
        total: state.applications.length,
      });
    });
  } catch (e) {
    return safeError(e);
  }
}
