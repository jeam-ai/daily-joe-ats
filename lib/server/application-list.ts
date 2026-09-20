import "server-only";
import type { Application } from "@/types";
import { transaction, readTransaction } from "./database";
import { getState, saveState } from "./repository";
export async function listApplications(params: URLSearchParams, demo = false) {
  // Backfill the indexed read model once for workspaces created before the queue.
  const counts = await readTransaction(async (tx) => ({
    apps: Number(
      (await tx.query("SELECT COUNT(*) AS n FROM applications"))[0].n,
    ),
    window: Number(
      (await tx.query("SELECT COUNT(*) AS n FROM intake_window"))[0].n,
    ),
  }));
  if (counts.apps !== counts.window)
    await transaction(async (tx) =>
      saveState(tx, await getState(tx), { sync: false }),
    );
  const page = Math.max(1, Math.min(100000, Number(params.get("page")) || 1));
  const values: unknown[] = [];
  const bind = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const json = (alias: string, path: string) =>
    process.env.DATABASE_URL &&
    !["sheets", "local"].includes(process.env.PERSISTENCE_PROVIDER || "")
      ? `(${alias}.payload::jsonb #>> '{${path.replaceAll(".", ",")}}')`
      : `json_extract(${alias}.payload,'$.${path}')`;
  const where = [
    `w.state ${demo ? "= 'Demo'" : "<> 'Demo'"}`,
    `${json("a", "deletedAt")} IS NULL`,
  ];
  const eq = (parameter: string, column: string) => {
    const v = params.get(parameter);
    if (v) where.push(`${column}=${bind(v)}`);
  };
  if (params.get("talent") === "1") where.push("a.status='Talent Pool'");
  else
    switch (params.get("tab")) {
      case "Active":
        where.push(
          demo
            ? "a.status NOT IN ('Hired','Rejected','Withdrawn','Talent Pool')"
            : "w.state='Active'",
        );
        break;
      case "Queued":
        where.push("w.state='Queued'");
        break;
      case "Interviews":
        where.push(
          "a.stage IN ('Initial Interview','Final Interview') AND a.status NOT IN ('Hired','Rejected','Withdrawn','Talent Pool')",
        );
        break;
      case "Pre-employment":
        where.push("a.stage='Requirements'");
        break;
      case "Onboarding":
        where.push("a.stage='Onboarding'");
        break;
      case "Hired":
        where.push("a.status='Hired'");
        break;
    }
  eq("stage", "a.stage");
  eq("status", "a.status");
  eq("need", "a.hiring_need_id");
  eq("position", json("a", "position"));
  eq("location", json("a", "location"));
  eq("screening", json("a", "screening.outcome"));
  eq("urgency", json("n", "urgency"));
  eq("employment", `COALESCE(${json("a", "employment.status")},'Active')`);
  const q = params.get("q")?.trim().toLowerCase();
  if (q) {
    const p = bind(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(
      `(LOWER(${json("a", "applicant.name")}) LIKE ${p} ESCAPE '\\' OR LOWER(${json("a", "applicant.email")}) LIKE ${p} ESCAPE '\\' OR LOWER(a.id) LIKE ${p} ESCAPE '\\')`,
    );
  }
  const experience = Number(params.get("experience"));
  if (experience > 0)
    where.push(
      `CAST(${json("a", "applicant.experience")} AS REAL)>=${bind(experience)}`,
    );
  const since = params.get("since");
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since))
    where.push(`w.received_at>=${bind(since)}`);
  const from = `FROM applications a JOIN intake_window w ON w.application_id=a.id LEFT JOIN hiring_needs n ON n.id=a.hiring_need_id WHERE ${where.join(" AND ")}`;
  return readTransaction(async (tx) => {
    const total = Number(
      (await tx.query(`SELECT COUNT(*) AS n ${from}`, values))[0].n,
    );
    const actual = Math.min(page, Math.max(1, Math.ceil(total / 20)));
    const rows = await tx.query(
      `SELECT a.payload ${from} ORDER BY w.received_at DESC,a.id DESC LIMIT 20 OFFSET ${bind((actual - 1) * 20)}`,
      values,
    );
    return {
      applications: rows.map(
        (r) => JSON.parse(String(r.payload)) as Application,
      ),
      total,
      page: actual,
    };
  });
}
