import "server-only";
import type { AppState } from "@/types";
import ExcelJS from "exceljs";
import { productionState } from "@/lib/data-policy";
import { trackerHeaders, trackerRows } from "@/lib/tracker";
export async function buildTracker(state: AppState) {
  state = productionState(state);
  const book = new ExcelJS.Workbook();
  book.creator = "Daily Joe Careers";
  book.created = new Date();
  const sheet = book.addWorksheet("Recruitment Tracker", {
    views: [{ state: "frozen", ySplit: 4, xSplit: 2 }],
  });
  sheet.mergeCells("A1:X1");
  sheet.getCell("A1").value = "DAILY JOE CAREERS · RECRUITMENT TRACKER";
  sheet.getCell("A1").font = {
    name: "Aptos",
    size: 18,
    bold: true,
    color: { argb: "FF203D51" },
  };
  sheet.getRow(1).height = 35;
  sheet.mergeCells("A2:X2");
  sheet.getCell("A2").value =
    `ATS reporting mirror · Updated ${state.trackerUpdatedAt || "No records imported"} · Source: Daily Joe Careers · ${state.applications.length} applicants`;
  sheet.addRow([]);
  sheet.addRow(trackerHeaders);
  trackerRows(state).forEach((row) => sheet.addRow(row));
  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: Math.max(4, sheet.rowCount), column: 24 },
  };
  sheet.columns.forEach((col, i) => {
    col.width = [0, 1, 3, 4, 5, 8, 9, 10, 16, 18].includes(i)
      ? 25
      : i === 2
        ? 34
        : i === 21
          ? 52
          : 24;
  });
  sheet.eachRow((row, n) => {
    if (n < 4) return;
    row.height = n === 4 ? 42 : 48;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = {
        name: "Aptos",
        size: 11,
        color: { argb: "FF233947" },
        bold: n === 4,
      };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: n === 4 ? "FFDCEBF5" : n % 2 ? "FFF4F7FA" : "FFFFFFFF",
        },
      };
    });
  });
  const colors: Record<string, string> = {
    Screening: "DCEBF5",
    "Initial Interview": "EDE3F5",
    "Final Interview": "FCE6D6",
    Requirements: "FFF1CF",
    Onboarding: "E0F1E5",
    Hired: "BEDFC9",
    Rejected: "FADDD8",
    Withdrawn: "E8EBEF",
    Urgent: "FADDD8",
    High: "FCE6D6",
    Medium: "FFF1CF",
    Low: "E0F1E5",
  };
  for (let row = 5; row <= sheet.rowCount; row++)
    for (const column of [7, 9, 10]) {
      const c = sheet.getCell(row, column);
      const color = colors[String(c.value)];
      if (color)
        c.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: color },
        };
    }
  for (const column of ["G", "I", "J"])
    sheet.addConditionalFormatting({
      ref: column + "5:" + column + "104",
      rules: Object.entries(colors).map(([value, color], i) => ({
        type: "expression" as const,
        priority: i + 1,
        formulae: [column + '5="' + value + '"'],
        style: {
          fill: {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: color },
          },
        },
      })),
    });
  sheet.pageSetup = {
    orientation: "landscape",
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: "1:4",
  };
  return new Uint8Array(await book.xlsx.writeBuffer());
}
