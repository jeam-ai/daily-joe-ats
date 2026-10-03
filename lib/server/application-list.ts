import "server-only";
import type { Application } from "@/types";
import type { ApplicantNeighbors } from "@/lib/applicant-navigation";
import { transaction, readTransaction, postgresConfigured } from "./database";
import { getState, saveState } from "./repository";
let readModelReady: Promise<void> | undefined;
export async function listApplications(params: URLSearchParams, demo = false) {
  // Backfill the indexed read model once for workspaces created before the queue.
  readModelReady ||= (async () => {
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
  })().catch((error) => {
    readModelReady = undefined;
    throw error;
  });
  await readModelReady;
  const query = applicationListQuery(params, demo);
  const { page, values, from } = query;
  return readTransaction(async (tx) => {
    if (params.get("selection") === "ids")
      return {
        applications: [] as Application[],
        total: 0,
        page,
        neighbors: null,
        neighborsById: {} as Record<string, ApplicantNeighbors>,
        ids: (
          await tx.query(
            `SELECT a.id ${from} ORDER BY w.received_at DESC,a.id DESC`,
            values,
          )
        ).map((r) => String(r.id)),
      };
    return readApplicationPage(tx, params, query);
  });
}

export function applicationListQuery(params: URLSearchParams, demo = false) {
  const page = Math.floor(
    Math.max(1, Math.min(100000, Number(params.get("page")) || 1)),
  );
  const limit = Math.floor(
    Math.max(1, Math.min(20, Number(params.get("limit")) || 20)),
  );
  const activitySort = !demo && params.get("sort") === "activity";
  const values: unknown[] = [];
  const bind = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const json = (alias: string, path: string) =>
    postgresConfigured()
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
  if (params.get("talent") === "1")
    where.push(
      `a.status='Talent Pool' AND ${json("a", "talentPoolExpiredAt")} IS NULL`,
    );
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
  const q = params.get("q")?.trim().replace(/\s+/g, " ").toLowerCase();
  if (q) {
    const p = bind(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(
      `(${["applicant.name", "applicant.email", "applicant.phone", "position", "location"].map((field) => `LOWER(${json("a", field)}) LIKE ${p} ESCAPE '\\'`).join(" OR ")} OR LOWER(a.id) LIKE ${p} ESCAPE '\\')`,
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
  const joins = `FROM applications a JOIN intake_window w ON w.application_id=a.id LEFT JOIN hiring_needs n ON n.id=a.hiring_need_id LEFT JOIN application_retention r ON r.application_id=a.id LEFT JOIN talent_pool_memberships tp ON tp.applicant_id=a.applicant_id`;
  const from = `${joins} WHERE ${where.join(" AND ")}`;
  const latest =
    "(SELECT MAX(occurred_at) FROM gmail_thread_events WHERE application_id=a.id)";
  const listFrom = from;
  const order = activitySort
    ? `CASE WHEN ${latest}>w.received_at THEN ${latest} ELSE w.received_at END DESC,w.received_at DESC,a.id DESC`
    : "w.received_at DESC,a.id DESC";
  return {
    page,
    limit,
    activitySort,
    values,
    bind,
    from,
    listFrom,
    order,
    latest,
  };
}
async function readApplicationPage(
  tx: import("./database").Transaction,
  params: URLSearchParams,
  query: ReturnType<typeof applicationListQuery>,
) {
  const {
    page,
    limit,
    activitySort,
    values,
    bind,
    from,
    listFrom,
    order,
    latest,
  } = query;
  const around = params.get("around");
  if (around) {
    const sequence = await tx.query(
      `SELECT id,previous_id,next_id,previous_previous_id,next_next_id,position,total FROM (
          SELECT a.id,LAG(a.id,2) OVER (ORDER BY ${order}) AS previous_previous_id,
            LAG(a.id) OVER (ORDER BY ${order}) AS previous_id,
            LEAD(a.id) OVER (ORDER BY ${order}) AS next_id,
            LEAD(a.id,2) OVER (ORDER BY ${order}) AS next_next_id,
            ROW_NUMBER() OVER (ORDER BY ${order}) AS position,COUNT(*) OVER() AS total
          ${listFrom}
        ) sequence WHERE id=${bind(around)}`,
      values,
    );
    const row = sequence[0];
    const neighborsById: Record<string, ApplicantNeighbors> = {};
    const total = Number(row?.total || 0);
    const position = Number(row?.position || 0);
    if (row) {
      neighborsById[around] = {
        previousId: row.previous_id ? String(row.previous_id) : null,
        nextId: row.next_id ? String(row.next_id) : null,
        position,
        total,
      };
      if (row.previous_id)
        neighborsById[String(row.previous_id)] = {
          previousId: row.previous_previous_id
            ? String(row.previous_previous_id)
            : null,
          nextId: around,
          position: position - 1,
          total,
        };
      if (row.next_id)
        neighborsById[String(row.next_id)] = {
          previousId: around,
          nextId: row.next_next_id ? String(row.next_next_id) : null,
          position: position + 1,
          total,
        };
    }
    return {
      applications: [] as Application[],
      total,
      page,
      neighbors: neighborsById[around] || null,
      neighborsById,
    };
  }
  const total = Number(
    (await tx.query(`SELECT COUNT(*) AS n ${from}`, values))[0].n,
  );
  const actual = Math.min(page, Math.max(1, Math.ceil(total / limit)));
  const offset = (actual - 1) * limit;
  const leading = Math.min(offset, 2);
  const rows = await tx.query(
    `SELECT a.id,a.payload,r.category AS retention_category,r.started_at AS retention_started_at,r.expires_at AS retention_expires_at,r.reason AS retention_reason,tp.expires_at AS talent_pool_expires_at,tp.grace_expires_at AS talent_pool_grace_expires_at,${activitySort ? latest : "NULL"} AS gmail_activity_at ${listFrom} ORDER BY ${order} LIMIT ${limit + leading + 2} OFFSET ${bind(Math.max(0, offset - 2))}`,
    values,
  );
  const visible = rows.slice(leading, leading + limit);
  const navigationStart = Math.max(0, leading - 1);
  const neighborsById = Object.fromEntries(
    rows.slice(navigationStart, leading + limit + 1).map((row, index) => [
      String(row.id),
      {
        previousId: rows[index + navigationStart - 1]?.id
          ? String(rows[index + navigationStart - 1].id)
          : null,
        nextId: rows[index + navigationStart + 1]?.id
          ? String(rows[index + navigationStart + 1].id)
          : null,
        position: offset - leading + navigationStart + index + 1,
        total,
      } satisfies ApplicantNeighbors,
    ]),
  );
  return {
    applications: visible.map((r) => {
      const application = JSON.parse(String(r.payload)) as Application;
      delete application.retentionCategory;
      delete application.retentionStartedAt;
      delete application.retentionExpiresAt;
      delete application.retentionReason;
      delete application.talentPoolExpiresAt;
      delete application.talentPoolGraceExpiresAt;
      delete application.gmailActivityAt;
      if (r.gmail_activity_at) {
        application.gmailActivityAt = String(r.gmail_activity_at);
        if (application.gmailActivityAt > application.lastActivity)
          application.lastActivity = application.gmailActivityAt;
      }
      if (r.retention_category) {
        application.retentionCategory = String(r.retention_category);
        application.retentionStartedAt = String(r.retention_started_at);
        application.retentionExpiresAt = String(r.retention_expires_at);
        application.retentionReason = String(r.retention_reason);
      }
      if (
        r.talent_pool_expires_at &&
        application.status === "Talent Pool" &&
        !application.talentPoolExpiredAt
      ) {
        application.talentPoolExpiresAt = String(r.talent_pool_expires_at);
        application.talentPoolGraceExpiresAt = String(
          r.talent_pool_grace_expires_at,
        );
      }
      return application;
    }),
    total,
    page: actual,
    neighbors: null,
    neighborsById,
  };
}

export async function filteredApplicationIds(
  tx: import("./database").Transaction,
  params: URLSearchParams,
  demo = false,
) {
  const { from, values } = applicationListQuery(params, demo);
  return (await tx.query(`SELECT a.id ${from}`, values)).map((r) =>
    String(r.id),
  );
}
