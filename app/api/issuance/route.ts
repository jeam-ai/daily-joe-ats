import ExcelJS from "exceljs";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { putRecord, transaction, type Transaction } from "@/lib/server/database";
import { audit, getState } from "@/lib/server/repository";
import { reconcileInventory } from "@/lib/issuance-stock";
import type {
  IssuanceCatalogItem,
  IssuanceCategory,
  IssuanceInventory,
  IssuanceRecord,
  IssuanceStatus,
} from "@/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const statuses = new Set<IssuanceStatus>([
  "Issued",
  "Pending",
  "Incomplete",
  "For Replacement",
  "Returned",
]);
const categories = new Set<IssuanceCategory>([
  "Uniform",
  "Welcome Kit",
  "Other",
]);

function canManageIssuance(role: string) {
  return ["Admin", "Talent Acquisition", "HR Generalist"].includes(role);
}

/**
 * Issuance is a small, self-contained operational register. Persist it without
 * replaying every application, interview, and applicant row in the workspace;
 * that full write can exceed a serverless request while an HR user is simply
 * correcting a branch or acknowledgement on one release record.
 */
async function saveIssuanceWorkspace(
  tx: Transaction,
  state: Awaited<ReturnType<typeof getState>>,
  changes: {
    issuance?: IssuanceRecord[];
    inventory?: IssuanceInventory[];
    catalog?: IssuanceCatalogItem[];
  },
) {
  delete state.currentUser;
  delete state.demoAvailable;
  state.revision = (state.revision || 0) + 1;
  await putRecord(tx, "workspace", "main", state);

  const upsert = async (collection: string, id: string, payload: unknown) => {
    await tx.query(
      `INSERT INTO ${collection}(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
      [id, JSON.stringify(payload)],
    );
  };
  for (const record of changes.issuance || [])
    await upsert("employee_issuance", record.id, record);
  for (const record of changes.inventory || [])
    await upsert("issuance_inventory", record.id, record);
  for (const record of changes.catalog || [])
    await upsert("issuance_catalog", record.id, record);
}
function text(value: unknown, limit = 250) {
  return String(value || "")
    .trim()
    .slice(0, limit);
}
function date(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString().slice(0, 10);
  const raw = cell.text.trim();
  if (!raw) return "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : "";
}
function sheetValue(
  row: ExcelJS.Row,
  headers: Map<string, number>,
  name: string,
) {
  const index = headers.get(name.toLowerCase());
  return index ? row.getCell(index) : null;
}
function sourceSignature(
  record: Pick<
    IssuanceRecord,
    | "category"
    | "employeeName"
    | "item"
    | "quantity"
    | "branch"
    | "issuedAt"
    | "receivedAt"
    | "size"
  >,
) {
  return [
    record.category,
    record.employeeName,
    record.item,
    record.quantity,
    record.branch,
    record.issuedAt,
    record.receivedAt,
    record.size,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .join("|");
}
function stockKey(
  record: Pick<IssuanceInventory, "category" | "role" | "item" | "size">,
) {
  return [record.category, record.role, record.item, record.size]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .join("|");
}
function stockId(
  record: Pick<IssuanceInventory, "category" | "role" | "item" | "size">,
) {
  return `stock-${stockKey(record)
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")}`;
}

export async function importIssuanceWorkbook(file: File, actor: string) {
  if (!file.name.toLowerCase().endsWith(".xlsx"))
    throw new SafeError(
      "Upload the original Uniform and Welcome Kit .xlsx workbook.",
    );
  if (!file.size || file.size > 8 * 1024 * 1024)
    throw new SafeError("The issuance workbook must be under 8 MB.");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(await file.arrayBuffer()) as never);
  } catch {
    throw new SafeError(
      "We couldn't read that workbook. Export an unlocked .xlsx copy and try again.",
    );
  }
  const issuanceSheets = workbook.worksheets.filter(
    (sheet) =>
      /^UPDATED MONITORING \(UNIFORM\)$/i.test(sheet.name) ||
      /^UPDATED MONITORING \(WELCOME KIT/i.test(sheet.name),
  );
  const onHandSheet = workbook.worksheets.find((sheet) =>
    /^ON-HAND$/i.test(sheet.name),
  );
  if (!issuanceSheets.length && !onHandSheet)
    throw new SafeError(
      "No supported issuance sheets were found. Use On Hand, UPDATED MONITORING (UNIFORM), or UPDATED MONITORING (WELCOME KIT).",
    );
  const now = new Date().toISOString();
  const records: IssuanceRecord[] = [];
  for (const sheet of issuanceSheets) {
    const category: IssuanceCategory = /UNIFORM/i.test(sheet.name)
      ? "Uniform"
      : "Welcome Kit";
    const headers = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, index) => {
      const label = cell.text.trim().toLowerCase();
      if (label) headers.set(label, index);
    });
    if (
      !headers.has("name") ||
      !headers.has("description") ||
      !headers.has("qty")
    )
      throw new SafeError(
        `${sheet.name} needs Name, Description, and QTY columns.`,
      );
    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const employeeName = text(sheetValue(row, headers, "name")?.text);
      const item = text(sheetValue(row, headers, "description")?.text);
      const quantity = Number(
        text(sheetValue(row, headers, "qty")?.text).replaceAll(",", ""),
      );
      if (!employeeName && !item) continue;
      if (!employeeName || !item || !Number.isInteger(quantity) || quantity < 1)
        throw new SafeError(
          `${sheet.name}, row ${rowNumber} needs a name, item description, and whole quantity.`,
        );
      const issuedAt = date(
        sheetValue(row, headers, "released date") || row.getCell(1),
      );
      const receivedAt = date(
        sheetValue(row, headers, "received date") || row.getCell(1),
      );
      records.push({
        id: crypto.randomUUID(),
        category,
        employeeName,
        item,
        quantity,
        size: text(sheetValue(row, headers, "size")?.text) || undefined,
        branch: text(sheetValue(row, headers, "store name")?.text) || undefined,
        condition:
          text(sheetValue(row, headers, "item status")?.text) || undefined,
        status: receivedAt ? "Issued" : "Pending",
        issuedAt: issuedAt || undefined,
        receivedAt: receivedAt || undefined,
        // The supplied issuance sheets represent items already released to
        // employees. HR confirmed those releases have signed acknowledgments.
        signed: !!issuedAt,
        source: `Workbook upload: ${file.name} / ${sheet.name}`,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  const inventory: IssuanceInventory[] = [];
  if (onHandSheet) {
    let category: IssuanceCategory = "Uniform";
    let role = "";
    for (
      let rowNumber = 1;
      rowNumber <= onHandSheet.actualRowCount;
      rowNumber++
    ) {
      const row = onHandSheet.getRow(rowNumber);
      const first = text(row.getCell(1).text);
      const second = text(row.getCell(2).text);
      if (!first) continue;
      if (/^description$/i.test(first)) continue;
      // ExcelJS exposes the value of a merged section label in every cell of
      // that merged row. Treat it as a section heading rather than an item.
      if ((!second || second === first) && !/^description$/i.test(first)) {
        category = /welcome\s*kit/i.test(first) ? "Welcome Kit" : "Uniform";
        role = text(first.replace(/welcome\s*kit/i, ""));
        continue;
      }
      const beginning = Number(second.replaceAll(",", ""));
      const issued = Number(text(row.getCell(3).text).replaceAll(",", ""));
      const onHand = Number(text(row.getCell(4).text).replaceAll(",", ""));
      if (
        !Number.isInteger(beginning) ||
        beginning < 0 ||
        !Number.isInteger(issued) ||
        issued < 0 ||
        !Number.isInteger(onHand) ||
        onHand < 0
      )
        throw new SafeError(
          `On Hand, row ${rowNumber} needs whole Beginning, Out, and Ending values.`,
        );
      const record = {
        category,
        role: role || undefined,
        item: first,
        beginning,
        issued,
        onHand,
        updatedAt: date(row.getCell(5))
          ? new Date(`${date(row.getCell(5))}T00:00:00.000Z`).toISOString()
          : now,
        source: `Workbook upload: ${file.name} / ${onHandSheet.name}`,
      } satisfies Omit<IssuanceInventory, "id">;
      inventory.push({ ...record, id: stockId(record) });
    }
  }
  if (!records.length && !inventory.length)
    throw new SafeError(
      "The supported sheets do not contain issuance or on-hand rows.",
    );
  return transaction(async (tx) => {
    const state = await getState(tx);
    const existing = new Map(
      (state.issuance || []).map((record) => [sourceSignature(record), record]),
    );
    const unique = records.filter(
      (record) => !existing.has(sourceSignature(record)),
    );
    let acknowledgmentsMarked = 0;
    const issuance = (state.issuance || []).map((record) => {
      const imported = records.find(
        (candidate) => sourceSignature(candidate) === sourceSignature(record),
      );
      if (imported?.signed && !record.signed) {
        acknowledgmentsMarked++;
        return { ...record, signed: true, updatedAt: now };
      }
      return record;
    });
    const currentInventory = new Map(
      (state.issuanceInventory || []).map((record) => [
        stockKey(record),
        record,
      ]),
    );
    let inventoryUpdated = 0;
    for (const record of inventory) {
      const current = currentInventory.get(stockKey(record));
      if (
        !current ||
        JSON.stringify({ ...current, id: undefined }) !==
          JSON.stringify({ ...record, id: undefined })
      ) {
        currentInventory.set(stockKey(record), {
          ...record,
          id: current?.id || record.id,
        });
        inventoryUpdated++;
      }
    }
    const catalog = [...(state.issuanceItems || [])];
    const catalogKeys = new Set(
      catalog.map((entry) => `${entry.category}|${entry.name}`.toLowerCase()),
    );
    let catalogAdded = 0;
    for (const entry of [...records, ...inventory]) {
      const key = `${entry.category}|${entry.item}`.toLowerCase();
      if (catalogKeys.has(key)) continue;
      catalog.push({
        id: `issuance-item-${key.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}`,
        category: entry.category,
        name: entry.item,
        active: true,
      });
      catalogKeys.add(key);
      catalogAdded++;
    }
    if (
      unique.length ||
      inventoryUpdated ||
      acknowledgmentsMarked ||
      catalogAdded
    ) {
      state.issuance = [...issuance, ...unique];
      state.issuanceInventory = reconcileInventory(
        [...currentInventory.values()],
        state.issuance,
      );
      state.issuanceItems = catalog;
      await saveIssuanceWorkspace(tx, state, {
        issuance: state.issuance,
        inventory: state.issuanceInventory,
        catalog: state.issuanceItems,
      });
    }
    await audit(tx, actor, "issuance.workbook_imported", undefined, {
      file: file.name,
      rowsImported: unique.length,
      duplicatesSkipped: records.length - unique.length,
      inventoryUpdated,
      acknowledgmentsMarked,
      catalogAdded,
      sheets: [...issuanceSheets, ...(onHandSheet ? [onHandSheet] : [])].map(
        (sheet) => sheet.name,
      ),
      excludedSheets: workbook.worksheets
        .filter((sheet) => sheet.name === "Monitoring")
        .map((sheet) => sheet.name),
    });
    return {
      created: unique.length,
      skipped: records.length - unique.length,
      inventoryUpdated,
      acknowledgmentsMarked,
      catalogAdded,
    };
  });
}

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (!canManageIssuance(user.role))
      throw new SafeError(
        "An authorized HR role is required to manage employee issuance.",
        403,
      );
    if (request.headers.get("x-djc-dataset") === "demo")
      throw new SafeError(
        "Exit Demo before changing employee issuance records.",
        403,
      );
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const file = (await request.formData()).get("file");
      if (!(file instanceof File))
        throw new SafeError("Choose an issuance workbook first.");
      return Response.json(await importIssuanceWorkbook(file, user.email));
    }
    const body = await request.json();
    if (body.action === "create") {
      const category = text(body.category) as IssuanceCategory;
      const status = text(body.status) as IssuanceStatus;
      const employeeName = text(body.employeeName);
      const item = text(body.item);
      const quantity = Number(body.quantity);
      if (!categories.has(category) || !statuses.has(status))
        throw new SafeError("Choose a valid issuance category and status.");
      if (!employeeName || !item || !Number.isInteger(quantity) || quantity < 1)
        throw new SafeError("Enter an employee, item, and whole quantity.");
      const now = new Date().toISOString();
      const record: IssuanceRecord = {
        id: crypto.randomUUID(),
        category,
        employeeName,
        employeeId: text(body.employeeId) || undefined,
        position: text(body.position) || undefined,
        branch: text(body.branch) || undefined,
        item,
        size: text(body.size) || undefined,
        quantity,
        condition: text(body.condition) || undefined,
        status,
        issuedAt: text(body.issuedAt, 20) || undefined,
        receivedAt: text(body.receivedAt, 20) || undefined,
        signed: body.signed === true,
        returnedAt: text(body.returnedAt, 20) || undefined,
        remarks: text(body.remarks, 2000) || undefined,
        source: "HR entry",
        createdAt: now,
        updatedAt: now,
      };
      return Response.json(
        await transaction(async (tx) => {
          const state = await getState(tx);
          state.issuance = [...(state.issuance || []), record];
          state.issuanceInventory = reconcileInventory(
            state.issuanceInventory || [],
            state.issuance,
          );
          await saveIssuanceWorkspace(tx, state, {
            issuance: [record],
            inventory: state.issuanceInventory,
          });
          await audit(tx, user.email, "issuance.created", undefined, {
            issuanceId: record.id,
            category: record.category,
            item: record.item,
          });
          return { record, inventory: state.issuanceInventory };
        }),
      );
    }
    if (
      body.action === "create-inventory" ||
      body.action === "update-inventory"
    ) {
      const category = text(body.category) as IssuanceCategory;
      const item = text(body.item);
      const role = text(body.role) || undefined;
      const size = text(body.size) || undefined;
      const beginning = Number(body.beginning);
      const issued = Number(body.issued);
      const onHand = Number(body.onHand);
      const manualCountOverride = body.manualCountOverride === true;
      const updatedDate = text(body.updatedAt, 20);
      if (!categories.has(category) || !item)
        throw new SafeError("Choose a valid stock category and item.");
      if (
        ![beginning, issued, onHand].every(
          (value) => Number.isInteger(value) && value >= 0,
        )
      )
        throw new SafeError(
          "Beginning, Out, and On hand must be whole, non-negative numbers.",
        );
      if (updatedDate && !Number.isFinite(Date.parse(updatedDate)))
        throw new SafeError("Enter a valid stock update date.");
      const candidate = {
        category,
        role,
        item,
        size,
        beginning,
        issued,
        onHand,
        manualCountOverride,
        updatedAt: updatedDate
          ? new Date(`${updatedDate}T00:00:00.000Z`).toISOString()
          : new Date().toISOString(),
      } satisfies Omit<IssuanceInventory, "id" | "source">;
      return Response.json(
        await transaction(async (tx) => {
          const state = await getState(tx);
          const inventory = state.issuanceInventory || [];
          const id = text(body.id);
          const existing = id
            ? inventory.find((record) => record.id === id)
            : undefined;
          if (body.action === "update-inventory" && !existing)
            throw new SafeError("That stock item no longer exists.", 404);
          const duplicate = inventory.find(
            (record) =>
              record.id !== existing?.id &&
              stockKey(record) === stockKey(candidate),
          );
          if (duplicate)
            throw new SafeError(
              "A matching stock item already exists. Update that row instead.",
            );
          const candidateRecord: IssuanceInventory = {
            ...candidate,
            id: existing?.id || stockId(candidate),
            source: existing?.source || "HR inventory entry",
          };
          state.issuanceInventory = reconcileInventory(
            existing
              ? inventory.map((item) =>
                  item.id === existing.id ? candidateRecord : item,
                )
              : [...inventory, candidateRecord],
            state.issuance || [],
          );
          const record = state.issuanceInventory.find(
            (item) => item.id === candidateRecord.id,
          )!;
          await saveIssuanceWorkspace(tx, state, {
            inventory: state.issuanceInventory,
          });
          await audit(
            tx,
            user.email,
            existing
              ? "issuance.inventory_updated"
              : "issuance.inventory_created",
            undefined,
            {
              inventoryId: record.id,
              category: record.category,
              item: record.item,
            },
          );
          return { record };
        }),
      );
    }
    if (body.action === "update") {
      const id = text(body.id);
      const category = text(body.category) as IssuanceCategory;
      const status = text(body.status) as IssuanceStatus;
      const employeeName = text(body.employeeName);
      const item = text(body.item);
      const quantity = Number(body.quantity);
      if (
        !id ||
        !categories.has(category) ||
        !statuses.has(status) ||
        !employeeName ||
        !item ||
        !Number.isInteger(quantity) ||
        quantity < 1
      )
        throw new SafeError(
          "Enter a valid employee, item, category, quantity, and status.",
        );
      return Response.json(
        await transaction(async (tx) => {
          const state = await getState(tx);
          const record = state.issuance?.find((item) => item.id === id);
          if (!record)
            throw new SafeError("That issuance record no longer exists.", 404);
          const previous = {
            category: record.category,
            employeeName: record.employeeName,
            employeeId: record.employeeId,
            position: record.position,
            branch: record.branch,
            item: record.item,
            size: record.size,
            quantity: record.quantity,
            condition: record.condition,
            status: record.status,
            issuedAt: record.issuedAt,
            receivedAt: record.receivedAt,
            returnedAt: record.returnedAt,
            signed: record.signed,
          };
          record.category = category;
          record.employeeName = employeeName;
          record.employeeId = text(body.employeeId) || undefined;
          record.position = text(body.position) || undefined;
          record.branch = text(body.branch) || undefined;
          record.item = item;
          record.size = text(body.size) || undefined;
          record.quantity = quantity;
          record.condition = text(body.condition) || undefined;
          record.status = status;
          record.issuedAt = text(body.issuedAt, 20) || undefined;
          record.signed = body.signed === true;
          record.receivedAt = text(body.receivedAt, 20) || undefined;
          record.returnedAt = text(body.returnedAt, 20) || undefined;
          record.remarks = text(body.remarks, 2000) || undefined;
          record.updatedAt = new Date().toISOString();
          state.issuanceInventory = reconcileInventory(
            state.issuanceInventory || [],
            state.issuance || [],
          );
          await saveIssuanceWorkspace(tx, state, {
            issuance: [record],
            inventory: state.issuanceInventory,
          });
          await audit(tx, user.email, "issuance.updated", undefined, {
            issuanceId: record.id,
            previous,
            current: {
              category: record.category,
              employeeName: record.employeeName,
              employeeId: record.employeeId,
              position: record.position,
              branch: record.branch,
              item: record.item,
              size: record.size,
              quantity: record.quantity,
              condition: record.condition,
              status: record.status,
              issuedAt: record.issuedAt,
              receivedAt: record.receivedAt,
              returnedAt: record.returnedAt,
              signed: record.signed,
            },
          });
          return { record, inventory: state.issuanceInventory };
        }),
      );
    }
    throw new SafeError("Choose an employee issuance action.");
  } catch (error) {
    return safeError(error);
  }
}
