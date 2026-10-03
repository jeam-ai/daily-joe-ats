"use client";
import { useState } from "react";
import type { IssuanceEmployee } from "@/lib/issuance-employees";
import type {
  IssuanceCategory,
  IssuanceInventory,
  IssuanceRecord,
} from "@/types";
import { canManage } from "@/lib/data-policy";
import { dayKey } from "@/lib/dates";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { Button, Field, Input, Select, Modal, Table } from "./ui";
import { BulkActions } from "./bulk-actions";
export function BulkIssuance({ employeeKeys }: { employeeKeys?: string[] }) {
  const { state, dataset, notify, patchState } = useApp();
  const [open, setOpen] = useState(false),
    [roster, setRoster] = useState<IssuanceEmployee[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [q, setQ] = useState(""),
    [branch, setBranch] = useState(""),
    [page, setPage] = useState(1),
    [category, setCategory] = useState<IssuanceCategory>("Uniform"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<Record<string, unknown>>(),
    [requestId, setRequestId] = useState("");
  const filtered = roster.filter(
    (p) =>
      (!q ||
        `${p.name} ${p.employeeId || ""}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!branch || p.branch === branch),
  );
  const selected = filtered.filter((p) => ids.includes(p.key)),
    all = selected.length > 0 && selected.length === filtered.length;
  const items = [
    ...new Set([
      ...(state?.issuanceItems || [])
        .filter((i) => i.active && i.category === category)
        .map((i) => i.name),
      ...(state?.issuanceInventory || [])
        .filter((i) => i.category === category)
        .map((i) => i.item),
      ...(state?.issuance || [])
        .filter((i) => i.category === category)
        .map((i) => i.item),
    ]),
  ];
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy || dataset === "demo" || !canManage(state?.currentUser)}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await requestJson<{ employees: IssuanceEmployee[] }>(
              "/api/issuance?employees=1",
            );
            setRoster(r.employees);
            setIds(employeeKeys || []);
            setQ("");
            setBranch("");
            setPage(1);
            setDraft(undefined);
            setRequestId(crypto.randomUUID());
            setOpen(true);
          } catch (e) {
            notify((e as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? "Loading employees…"
          : employeeKeys?.length
            ? `Bulk issuance · ${employeeKeys.length} employees`
            : "Bulk issuance"}
      </Button>
      {open && (
        <Modal
          title="Bulk employee issuance"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {draft ? (
            <>
              <p>
                Issue{" "}
                <strong>
                  {String(draft.quantity)} × {String(draft.item)}
                </strong>{" "}
                to each of <strong>{selected.length} employees</strong> on{" "}
                {String(draft.issuedAt)}. Issued by {String(draft.issuedBy)}.
              </p>
              <p>
                Total quantity: {Number(draft.quantity) * selected.length}. Each
                employee receives a separate issuance record and audit entry.
              </p>
              <ul>
                {selected.map((p) => (
                  <li key={p.key}>
                    {p.name} · {p.branch || "Branch not recorded"}
                  </li>
                ))}
              </ul>
              <div className="modal-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setDraft(undefined)}
                >
                  Back
                </Button>
                <Button
                  disabled={busy || !selected.length}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const r = await requestJson<{
                        records: IssuanceRecord[];
                        inventory: IssuanceInventory[];
                      }>("/api/issuance", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          ...draft,
                          action: "bulk-create",
                          requestId,
                          employeeKeys: selected.map((p) => p.key),
                          confirmed: true,
                        }),
                      });
                      patchState((s) => ({
                        ...s,
                        issuance: [
                          ...(s.issuance || []),
                          ...r.records.filter(
                            (r) => !s.issuance?.some((e) => e.id === r.id),
                          ),
                        ],
                        issuanceInventory: r.inventory,
                      }));
                      setOpen(false);
                      notify(
                        `${r.records.length} individual issuance records created.`,
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Recording issuance…" : "Confirm issuance"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Search employees">
                  <Input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setIds([]);
                      setPage(1);
                    }}
                  />
                </Field>
                <Field label="Branch">
                  <Select
                    value={branch}
                    onChange={(e) => {
                      setBranch(e.target.value);
                      setIds([]);
                      setPage(1);
                    }}
                  >
                    <option value="">All branches</option>
                    {[
                      ...new Set(roster.map((p) => p.branch).filter(Boolean)),
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <BulkActions
                count={selected.length}
                total={filtered.length}
                allSelected={all}
                onSelectAll={() =>
                  setIds(all ? [] : filtered.map((p) => p.key))
                }
                onClear={() => setIds([])}
                busy={busy}
              />
              <Table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Employee</th>
                    <th>Position / branch</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * 20, page * 20).map((p) => (
                    <tr key={p.key}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Issue to ${p.name}`}
                          checked={ids.includes(p.key)}
                          onChange={(e) =>
                            setIds((ids) =>
                              e.target.checked
                                ? [...ids, p.key]
                                : ids.filter((id) => id !== p.key),
                            )
                          }
                        />
                      </td>
                      <td>{p.name}</td>
                      <td>
                        {p.position} · {p.branch}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {!filtered.length && (
                <p role="status">No employees match the current filters.</p>
              )}
              <div className="table-footer">
                <Button
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <span>
                  Page {page} of {Math.max(1, Math.ceil(filtered.length / 20))}
                </span>
                <Button
                  variant="ghost"
                  disabled={page * 20 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  setDraft({
                    category,
                    item: String(data.get("item")),
                    quantity: Number(data.get("quantity")),
                    issuedAt: String(data.get("issuedAt")),
                    issuedBy: String(data.get("issuedBy")),
                    size: String(data.get("size")),
                    condition: String(data.get("condition")),
                    notes: String(data.get("notes")),
                    signed: data.get("signed") === "on",
                  });
                }}
              >
                <div className="form-grid">
                  <Field label="Category">
                    <Select
                      value={category}
                      onChange={(e) =>
                        setCategory(e.target.value as IssuanceCategory)
                      }
                    >
                      {["Uniform", "Welcome Kit", "Other"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Item">
                    <Select name="item" required defaultValue="">
                      <option value="" disabled>
                        Choose configured item
                      </option>
                      {items.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Quantity per employee">
                    <Input
                      type="number"
                      name="quantity"
                      min="1"
                      max="1000"
                      defaultValue="1"
                      required
                    />
                  </Field>
                  <Field label="Issuance date">
                    <Input
                      type="date"
                      name="issuedAt"
                      defaultValue={dayKey(
                        Date.now(),
                        state?.preferences.timezone,
                      )}
                      required
                    />
                  </Field>
                  <Field label="Issued by">
                    <Input
                      name="issuedBy"
                      defaultValue={
                        state?.currentUser?.name || state?.currentUser?.email
                      }
                      required
                    />
                  </Field>
                  <Field label="Condition">
                    <Input name="condition" defaultValue="New" />
                  </Field>
                  <Field label="Size">
                    <Input name="size" />
                  </Field>
                  <Field label="Notes">
                    <Input name="notes" />
                  </Field>
                </div>
                <label className="checkbox-label">
                  <input type="checkbox" name="signed" /> All selected employees
                  signed their acknowledgments
                </label>
                <div className="modal-actions">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!selected.length || busy}>
                    Review issuance
                  </Button>
                </div>
              </form>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
