import { requireUser } from "@/lib/auth/session";
import { SafeError, demoEnabled } from "@/lib/server/config";
import { readTransaction } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { monthKey } from "@/lib/dates";

function count(values: string[]) {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return Object.entries(result)
    .map(([name, total]) => ({ name, count: total }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function GET(request: Request) {
  try {
    await requireUser();
    const demo = request.headers.get("x-djc-dataset") === "demo";
    if (demo && !demoEnabled()) throw new SafeError("Demo data is unavailable.", 403);
    const range = new URL(request.url).searchParams.get("range") || "all";
    if (!["all", "30", "7"].includes(range)) throw new SafeError("Invalid report period.");
    const state = await readTransaction((tx) => getState(tx));
    const now = Date.now();
    const applications = state.applications.filter((application) => {
      if (!!application.isDemo !== demo || application.deletedAt) return false;
      return range === "all" || now - Date.parse(application.appliedAt) < Number(range) * 86400000;
    });
    const hires = applications.filter((application) => application.hiredAt);
    const hireDays = hires.map((application) =>
      Math.max(0, (Date.parse(application.hiredAt!) - Date.parse(application.appliedAt)) / 86400000),
    );
    const timezone = state.preferences.timezone || "Asia/Manila";
    const currentMonth = monthKey(now, timezone);
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(`${currentMonth}-15T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() - 5 + index);
      const key = date.toISOString().slice(0, 7);
      return {
        key,
        count: applications.filter((application) => monthKey(application.appliedAt, timezone) === key).length,
      };
    });
    const details = {
      rejectionReasons: count(applications.filter((a) => a.status === "Rejected").map((a) => a.rejectionReason || "Not provided")),
      withdrawalReasons: count(applications.filter((a) => a.status === "Withdrawn").map((a) => a.withdrawalReason || "Not provided")),
      sources: count(applications.map((a) => a.source || "Not recorded")),
      employment: count(hires.map((a) => a.employment?.status || "Active")),
      screening: count(applications.map((a) => a.screening.outcome)),
      interviews: count(applications.flatMap((a) => a.interviews.map((i) => `${i.stage} · ${i.status}`))),
    };
    const group = (key: "position" | "location" | "stage" | "status") =>
      count(applications.map((application) => application[key]));
    return Response.json({
      total: applications.length,
      hired: applications.filter((a) => a.status === "Hired").length,
      talentPool: applications.filter((a) => a.status === "Talent Pool").length,
      interviewPipeline: applications.filter((a) => a.stage.includes("Interview")).length,
      screening: details.screening,
      groups: { position: group("position"), location: group("location"), stage: group("stage"), status: group("status") },
      months,
      averageDaysToHire: hireDays.length ? Math.round(hireDays.reduce((sum, value) => sum + value, 0) / hireDays.length) : null,
      hireCount: hires.length,
      details,
      hiringNeeds: state.hiringNeeds.filter((need) => !!need.isDemo === demo),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeError(error);
  }
}
