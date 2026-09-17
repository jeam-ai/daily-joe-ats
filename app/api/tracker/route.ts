import { requireUser } from "@/lib/auth/session";
import { publicState } from "@/lib/server/repository";
import { safeError } from "@/lib/server/response";
import { transaction, readRecord } from "@/lib/server/database";
import { buildTracker } from "@/lib/server/tracker";
export const runtime = "nodejs";
export async function GET() {
  try {
    const state = await publicState(await requireUser());
    const saved = await transaction((tx) =>
      readRecord<{ revision: number; base64: string }>(
        tx,
        "tracker",
        "workbook",
      ),
    );
    return new Response(
      saved && saved.revision === state.revision
        ? new Uint8Array(Buffer.from(saved.base64, "base64"))
        : await buildTracker(state),
      {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition":
            'attachment; filename="daily-joe-careers-tracker.xlsx"',
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    return safeError(e);
  }
}
