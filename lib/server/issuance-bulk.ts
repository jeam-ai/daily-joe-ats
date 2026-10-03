import "server-only";
import { z } from "zod";
import type { IssuanceRecord, User } from "@/types";
import { issuanceEmployees } from "@/lib/issuance-employees";
import {
  reconcileInventory,
  statusAfterReleaseDate,
} from "@/lib/issuance-stock";
import { canManage } from "@/lib/data-policy";
import { dayKey } from "@/lib/dates";
import { transaction, readRecord, putRecord } from "./database";
import { getState, audit } from "./repository";
import { SafeError } from "./config";
const inputSchema = z.object({
  requestId: z.uuid(),
  employeeKeys: z.array(z.string()).min(1).max(10000),
  category: z.enum(["Uniform", "Welcome Kit", "Other"]),
  item: z.string().trim().min(1).max(250),
  quantity: z.number().int().min(1).max(1000),
  issuedAt: z.iso.date(),
  issuedBy: z.string().trim().min(1).max(254),
  condition: z.string().trim().max(250).default(""),
  size: z.string().trim().max(60).default(""),
  notes: z.string().trim().max(2000).default(""),
  signed: z.boolean().default(false),
  confirmed: z.literal(true),
});
export async function bulkIssue(input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError("Authorized HR access required.", 403);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "Confirm employees, item, quantity, issuance date, and issuer.",
    );
  const body = parsed.data;
  if (new Set(body.employeeKeys).size !== body.employeeKeys.length)
    throw new SafeError("Select each employee once.");
  return transaction(async (tx) => {
    const key = `${user.email}:${body.requestId}`;
    const replay = await readRecord<{ records: IssuanceRecord[] }>(
      tx,
      "bulk_issuance",
      key,
    );
    const state = await getState(tx);
    if (replay) return { ...replay, inventory: state.issuanceInventory };
    const roster = new Map(issuanceEmployees(state).map((p) => [p.key, p]));
    if (
      !state.issuanceItems?.some(
        (i) => i.active && i.category === body.category && i.name === body.item,
      ) &&
      ![...(state.issuance || []), ...(state.issuanceInventory || [])].some(
        (i) => i.category === body.category && i.item === body.item,
      )
    )
      throw new SafeError("Choose an existing issuance item.");
    const now = new Date().toISOString();
    const records = body.employeeKeys.map((key): IssuanceRecord => {
      const p = roster.get(key);
      if (!p)
        throw new SafeError(
          "An employee is no longer available. Refresh the selection.",
          409,
        );
      return {
        id: crypto.randomUUID(),
        category: body.category,
        employeeName: p.name,
        employeeId: p.employeeId,
        applicationId: p.applicationId,
        position: p.position,
        branch: p.branch,
        item: body.item,
        quantity: body.quantity,
        size: body.size || undefined,
        condition: body.condition || undefined,
        status: "Issued",
        issuedAt: body.issuedAt,
        issuedBy: body.issuedBy,
        signed: body.signed,
        remarks: body.notes || undefined,
        source: "HR bulk issuance",
        createdAt: now,
        updatedAt: now,
        batchId: body.requestId,
      };
    });
    state.issuance = [...(state.issuance || []), ...records];
    state.issuanceInventory = reconcileInventory(
      state.issuanceInventory || [],
      state.issuance,
    );
    delete state.currentUser;
    delete state.demoAvailable;
    state.revision = (state.revision || 0) + 1;
    await putRecord(tx, "workspace", "main", state);
    for (const r of records) {
      await tx.query(
        "INSERT INTO employee_issuance(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [r.id, JSON.stringify(r)],
      );
      await audit(tx, user.email, "issuance.created", r.applicationId, {
        record: r,
        batchId: body.requestId,
        issuedBy: body.issuedBy,
      });
    }
    for (const r of state.issuanceInventory)
      await tx.query(
        "INSERT INTO issuance_inventory(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [r.id, JSON.stringify(r)],
      );
    await audit(tx, user.email, "issuance.bulk_created", undefined, {
      batchId: body.requestId,
      recordIds: records.map((r) => r.id),
      quantityPerEmployee: body.quantity,
    });
    await putRecord(tx, "bulk_issuance", key, { records });
    return { records, inventory: state.issuanceInventory };
  });
}

export async function bulkUpdateIssuance(input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError("Authorized HR access required.", 403);
  const parsed = z
    .object({
      requestId: z.uuid(),
      rows: z
        .array(z.object({ id: z.string(), updatedAt: z.string() }))
        .min(1)
        .max(10000),
      operation: z.enum(["status", "note"]),
      status: z
        .enum([
          "Issued",
          "Pending",
          "Incomplete",
          "For Replacement",
          "Returned",
        ])
        .optional(),
      note: z.string().trim().max(2000).default(""),
      confirmed: z.literal(true),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new SafeError("Confirm the issuance selection and action.");
  const body = parsed.data;
  if (
    new Set(body.rows.map((r) => r.id)).size !== body.rows.length ||
    (body.operation === "note" && !body.note) ||
    (body.operation === "status" && !body.status)
  )
    throw new SafeError(
      "Choose a status or enter a note for the selected records.",
    );
  return transaction(async (tx) => {
    const state = await getState(tx),
      key = `${user.email}:${body.requestId}`;
    const replay = await readRecord<{ records: IssuanceRecord[] }>(
      tx,
      "bulk_issuance_update",
      key,
    );
    if (replay) return { ...replay, inventory: state.issuanceInventory };
    const versions = new Map(body.rows.map((r) => [r.id, r.updatedAt]));
    const records = (state.issuance || []).filter((r) => versions.has(r.id));
    if (
      records.length !== versions.size ||
      records.some((r) => versions.get(r.id) !== r.updatedAt)
    )
      throw new SafeError(
        "An issuance record changed. Refresh before applying this action.",
        409,
      );
    const now = new Date().toISOString();
    for (const record of records) {
      const previous = structuredClone(record);
      if (body.operation === "status") {
        record.status = statusAfterReleaseDate(body.status!, record.issuedAt);
        if (record.status === "Returned")
          record.returnedAt = dayKey(now, state.preferences.timezone);
        else delete record.returnedAt;
      } else
        record.remarks = [record.remarks, body.note].filter(Boolean).join("\n");
      record.updatedAt = now;
      await audit(tx, user.email, "issuance.updated", record.applicationId, {
        issuanceId: record.id,
        previous,
        current: record,
        batchId: body.requestId,
      });
      await tx.query(
        "INSERT INTO employee_issuance(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [record.id, JSON.stringify(record)],
      );
    }
    state.issuanceInventory = reconcileInventory(
      state.issuanceInventory || [],
      state.issuance || [],
    );
    delete state.currentUser;
    delete state.demoAvailable;
    state.revision = (state.revision || 0) + 1;
    await putRecord(tx, "workspace", "main", state);
    for (const r of state.issuanceInventory)
      await tx.query(
        "INSERT INTO issuance_inventory(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [r.id, JSON.stringify(r)],
      );
    await putRecord(tx, "bulk_issuance_update", key, { records });
    return { records, inventory: state.issuanceInventory };
  });
}
