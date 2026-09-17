import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildTracker } from "../../lib/server/tracker";
import { createSeed } from "../../lib/mock/seed";
import { trackerHeaders } from "../../lib/tracker";
test("Excel output retains IDs, all columns, formatting, frozen headings and formula-safe strings", async () => {
  const state = createSeed();
  state.applications[0].applicant.name = '=HYPERLINK("https://example.com")';
  const bytes = await buildTracker(state);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const sheet = book.getWorksheet("Recruitment Tracker")!;
  assert.equal(sheet.rowCount, state.applications.length + 4);
  assert.equal(sheet.getCell("A5").value, state.applications[0].id);
  assert.equal(sheet.getCell("B5").type, ExcelJS.ValueType.String);
  assert.equal(sheet.views[0].state, "frozen");
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.getRow(4).cellCount, 24);
  assert.equal(sheet.getCell("X4").value, trackerHeaders[23]);
  assert.ok(
    (sheet as unknown as { conditionalFormattings: unknown[] })
      .conditionalFormattings.length,
  );
  assert.equal(sheet.getRow(4).height, 42);
});
