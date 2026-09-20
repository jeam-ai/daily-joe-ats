import { reportIssue } from "@/lib/server/diagnostics";
import { SafeError } from "@/lib/server/config";
import { requireUser } from "@/lib/auth/session";
import { audit, publicState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { transaction, readRecord } from "@/lib/server/database";
import { buildTracker } from "@/lib/server/tracker";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const state = await publicState(user);
    const talent = new URL(request.url).searchParams.get("scope") === "talent";
    if (talent)
      state.applications = state.applications.filter(
        (a) => a.status === "Talent Pool",
      );
    const saved = await transaction((tx) =>
      readRecord<{ revision: number; base64: string }>(
        tx,
        "tracker",
        "workbook",
      ),
    );
    const output =
      saved && !talent && saved.revision === state.revision
        ? new Uint8Array(Buffer.from(saved.base64, "base64"))
        : await buildTracker(state);
    await transaction((tx) =>
      audit(tx, user.email, "reports.exported", undefined, {
        type: talent ? "Talent Pool" : "Recruitment tracker",
        recordCount: state.applications.filter((a) => !a.isDemo && !a.deletedAt)
          .length,
      }),
    );
    return new Response(output, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          'attachment; filename="daily-joe-careers-tracker.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (!(e instanceof SafeError) || e.status >= 500)
      await reportIssue("export.failed");
    return safeError(e);
  }
}
