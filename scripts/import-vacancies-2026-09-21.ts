import "server-only";
import { planVacancyReportImport } from "../lib/vacancy-report";
import { readTransaction, transaction } from "../lib/server/database";
import { audit, getState, saveState } from "../lib/server/repository";

const url = process.env.AIVEN_DATABASE_URL || process.env.DATABASE_URL;
if (
  process.env.PERSISTENCE_PROVIDER !== "postgres" ||
  !url ||
  !new URL(url).hostname.toLowerCase().endsWith(".aivencloud.com") ||
  !process.env.AIVEN_CA_CERT
)
  throw Error("Aiven PostgreSQL Preview configuration is required.");

const apply = process.argv.includes("--apply");
const result = apply
  ? await transaction(async (tx) => {
      const state = await getState(tx);
      const plan = planVacancyReportImport(state);
      if (plan.needs.length || plan.locations.length) {
        state.locations = [...(state.locations || []), ...plan.locations];
        state.hiringNeeds.push(...plan.needs);
        await audit(
          tx,
          "System",
          "hiring.vacancies_report_imported",
          undefined,
          {
            reportDate: "2026-09-21",
            targetDate: "2026-10-15",
            createdNeeds: plan.needs.length,
            createdLocations: plan.locations.length,
            reportedOperationsTotal: 19,
            itemizedOperationsTotal: 18,
          },
        );
        await saveState(tx, state, { sync: false });
      }
      return plan;
    })
  : await readTransaction(async (tx) =>
      planVacancyReportImport(await getState(tx)),
    );
console.log(
  JSON.stringify({
    mode: apply ? "applied" : "dry-run",
    newHiringNeeds: result.needs.length,
    newLocations: result.locations.map((location) => location.name),
    existingSkipped: result.skipped,
    newSlots: result.needs.reduce((count, need) => count + need.slots, 0),
    operationsTotalDiscrepancy: "Printed 19; itemized rows sum to 18",
    targetDate: "2026-10-15",
  }),
);
