import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { transaction } from "@/lib/server/database";
import { safeError } from "@/lib/server/response";
import { audit, getState, saveState } from "@/lib/server/repository";
import { planVacancyReportImport } from "@/lib/vacancy-report";

export const runtime = "nodejs";

// A one-time, idempotent staging import of the itemized vacancies supplied by
// HR. Production traffic and applicant records are never changed by this route.
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError("Administrator access required.", 403);
    if (
      process.env.VERCEL_ENV !== "preview" ||
      process.env.PERSISTENCE_PROVIDER !== "postgres"
    )
      throw new SafeError(
        "This import is available on Aiven Preview only.",
        403,
      );
    const body = await request.json();
    if (body.confirmed !== true)
      throw new SafeError("Confirm the vacancies report import first.");
    const result = await transaction(async (tx) => {
      const state = await getState(tx);
      const plan = planVacancyReportImport(state);
      if (plan.needs.length || plan.locations.length) {
        state.locations = [...(state.locations || []), ...plan.locations];
        state.hiringNeeds.push(...plan.needs);
        await audit(
          tx,
          user.email,
          "hiring.vacancies_report_imported",
          undefined,
          {
            reportDate: "2026-09-21",
            targetDate: "2026-10-15",
            createdNeeds: plan.needs.length,
            createdLocations: plan.locations.length,
            itemizedOperationsSlots: 18,
            headOfficeSlots: 2,
            printedOperationsTotal: 19,
          },
        );
        await saveState(tx, state, { sync: false });
      }
      return {
        createdNeeds: plan.needs.length,
        createdLocations: plan.locations.length,
        existingSkipped: plan.skipped,
        createdSlots: plan.needs.reduce((count, need) => count + need.slots, 0),
      };
    });
    return Response.json(result);
  } catch (error) {
    return safeError(error);
  }
}
