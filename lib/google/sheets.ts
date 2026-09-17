import "server-only";
import { transaction, readRecord, putRecord } from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import { withStore } from "@/lib/server/store";
import { accessToken } from "./gmail/service";
import { trackerHeaders, trackerRows } from "@/lib/tracker";
// One-way mirror into the explicitly configured dedicated tab. The ATS always wins.
export async function syncSheets() {
  if (!process.env.GOOGLE_SHEETS_ID)
    return "Excel tracker updated; Google Sheets is not configured.";
  const connection = await withStore((s) => s.sheetsConnection, false);
  if (!connection)
    return "Google Sheets authorization required. Excel tracker is current.";
  try {
    const token = await accessToken(connection);
    return await transaction(async (tx) => {
      const state = await getState(tx);
      const tab = process.env.GOOGLE_SHEETS_TAB || "ATS Tracker";
      const range = `'${tab.replaceAll("'", "''")}'!A1:X101`;
      const rows = [trackerHeaders, ...trackerRows(state)];
      while (rows.length < 101) rows.push(Array(24).fill(""));
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID!)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!r.ok) throw Error();
      await putRecord(tx, "sync", "completed", {
        revision: state.revision,
        at: new Date().toISOString(),
      });
      return "Google Sheets synchronized.";
    });
  } catch {
    return "Failed to synchronize Google Sheets. Your ATS records are saved; retry from Integrations.";
  }
}
