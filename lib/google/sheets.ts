import { reportIssue, resolveIssue } from "@/lib/server/diagnostics";
import { writeAudit } from "@/lib/server/audit";
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
    const result = await transaction(async (tx) => {
      const state = await getState(tx);
      const tab = process.env.GOOGLE_SHEETS_TAB || "ATS Tracker";
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID!)}`;
      const formatKey = `format:${process.env.GOOGLE_SHEETS_ID}:${tab}`;
      if (!(await readRecord(tx, "sync", formatKey))) {
        const metadata = await fetch(`${base}?fields=sheets.properties`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!metadata.ok) throw Error();
        const workbook = (await metadata.json()) as {
          sheets?: {
            properties: {
              sheetId: number;
              title: string;
              gridProperties?: { rowCount: number; columnCount: number };
            };
          }[];
        };
        const sheet = workbook.sheets?.find(
          (s) => s.properties.title === tab,
        )?.properties;
        if (!sheet) throw Error();
        const sheetId = sheet.sheetId;
        const formatted = await fetch(`${base}:batchUpdate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            requests: [
              {
                updateSheetProperties: {
                  properties: {
                    sheetId,
                    gridProperties: {
                      frozenRowCount: 1,
                      rowCount: Math.max(
                        101,
                        sheet.gridProperties?.rowCount || 101,
                      ),
                      columnCount: Math.max(
                        24,
                        sheet.gridProperties?.columnCount || 24,
                      ),
                    },
                  },
                  fields: "gridProperties(frozenRowCount,rowCount,columnCount)",
                },
              },
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 24,
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: { red: 0.21, green: 0.37, blue: 0.57 },
                      textFormat: {
                        bold: true,
                        foregroundColor: { red: 1, green: 1, blue: 1 },
                      },
                      wrapStrategy: "WRAP",
                    },
                  },
                  fields:
                    "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
                },
              },
              {
                setBasicFilter: {
                  filter: {
                    range: {
                      sheetId,
                      startRowIndex: 0,
                      endRowIndex: 101,
                      startColumnIndex: 0,
                      endColumnIndex: 24,
                    },
                  },
                },
              },
              {
                updateDimensionProperties: {
                  range: {
                    sheetId,
                    dimension: "COLUMNS",
                    startIndex: 0,
                    endIndex: 24,
                  },
                  properties: { pixelSize: 180 },
                  fields: "pixelSize",
                },
              },
            ],
          }),
        });
        if (!formatted.ok) throw Error();
        await putRecord(tx, "sync", formatKey, {
          sheetId,
          at: new Date().toISOString(),
        });
      }
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
      await writeAudit(tx, "System", "sheets.synchronized", undefined, {
        revision: state.revision,
        recordCount: trackerRows(state).length,
      });
      return "Google Sheets synchronized.";
    });
    await resolveIssue("sheets.sync").catch(() => {});
    return result;
  } catch {
    await reportIssue("sheets.sync");
    return "Failed to synchronize Google Sheets. Your ATS records are saved; retry from Integrations.";
  }
}
