import test from "node:test";
import assert from "node:assert/strict";
import { reconcileInventory } from "../lib/issuance-stock";
import type { IssuanceInventory, IssuanceRecord } from "../types";

const stock: IssuanceInventory = {
  id: "cap-stock",
  category: "Uniform",
  item: "Cap",
  beginning: 15,
  issued: 0,
  onHand: 15,
  updatedAt: "2026-09-30T00:00:00.000Z",
};
const release = (overrides: Partial<IssuanceRecord> = {}): IssuanceRecord => ({
  id: "release-1",
  category: "Uniform",
  employeeName: "Employee",
  item: "Cap",
  quantity: 2,
  status: "Issued",
  signed: true,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  ...overrides,
});

test("stock automatically follows active releases and beginning minus out", () => {
  const [updated] = reconcileInventory([stock], [release()]);
  assert.equal(updated.issued, 2);
  assert.equal(updated.onHand, 13);

  const [returned] = reconcileInventory(
    [updated],
    [release({ status: "Returned", returnedAt: "2026-09-30" })],
  );
  assert.equal(returned.issued, 0);
  assert.equal(returned.onHand, 15);
});

test("a verified physical-count override remains untouched", () => {
  const [updated] = reconcileInventory(
    [{ ...stock, manualCountOverride: true, issued: 4, onHand: 11 }],
    [release({ quantity: 9 })],
  );
  assert.equal(updated.issued, 4);
  assert.equal(updated.onHand, 11);
});
