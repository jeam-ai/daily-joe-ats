"use client";

import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Gift,
  PackageCheck,
  Plus,
  Search,
  Shirt,
  Upload,
} from "lucide-react";
import { useApp } from "./provider";
import { clientFetch } from "@/lib/client-request";
import { formatDate } from "@/lib/dates";
import { releasedForStock, statusAfterReleaseDate } from "@/lib/issuance-stock";
import type {
  IssuanceCategory,
  IssuanceInventory,
  IssuanceRecord,
  IssuanceStatus,
} from "@/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingSkeleton,
  MetricCard,
  Modal,
  Select,
  StatusBadge,
  Table,
  Tabs,
} from "./ui";
import { RichTextEditor } from "./rich-text";

const statuses: IssuanceStatus[] = [
  "Issued",
  "Pending",
  "Incomplete",
  "For Replacement",
  "Returned",
];
const categories: IssuanceCategory[] = ["Uniform", "Welcome Kit", "Other"];
type IssuanceSort = "latest-updated" | "latest-issued" | "employee-a-z";
const today = () => new Date().toISOString().slice(0, 10);

function employeeCount(records: IssuanceRecord[]) {
  return new Set(records.map((record) => record.employeeName.toLowerCase()))
    .size;
}

export function EmployeeIssuance() {
  const { state, notify, refresh, patchState, dataset } = useApp();
  const [view, setView] = useState("All issuance");
  const [statusFilter, setStatusFilter] = useState<"All" | IssuanceStatus>(
    "All",
  );
  const [sort, setSort] = useState<IssuanceSort>("latest-updated");
  const [query, setQuery] = useState("");
  const [newCategory, setNewCategory] = useState<IssuanceCategory>("Uniform");
  const [stockCategory, setStockCategory] =
    useState<IssuanceCategory>("Uniform");
  const [stockItem, setStockItem] = useState("");
  const [stockBeginning, setStockBeginning] = useState(0);
  const [manualStockCountOverride, setManualStockCountOverride] =
    useState(false);
  const [manualStockIssued, setManualStockIssued] = useState(0);
  const [manualStockOnHand, setManualStockOnHand] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newStatus, setNewStatus] = useState<IssuanceStatus>("Issued");
  const [newReleasedAt, setNewReleasedAt] = useState(today);
  const [editing, setEditing] = useState<IssuanceRecord | null>(null);
  const [editingStock, setEditingStock] = useState<
    IssuanceInventory | "new" | null
  >(null);
  const [busy, setBusy] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const records = state?.issuance || [];
  const inventory = state?.issuanceInventory || [];
  const automaticStockOut =
    editingStock && editingStock !== "new"
      ? releasedForStock(editingStock, records)
      : 0;
  const catalog = useMemo(() => {
    const configured = (state?.issuanceItems || []).filter(
      (item) => item.active,
    );
    const seen = new Set(
      configured.map((item) => `${item.category}|${item.name}`.toLowerCase()),
    );
    for (const source of [...inventory, ...records]) {
      const key = `${source.category}|${source.item}`.toLowerCase();
      if (seen.has(key)) continue;
      configured.push({
        id: `derived-${key.replaceAll(/[^a-z0-9]+/g, "-")}`,
        category: source.category,
        name: source.item,
        active: true,
      });
      seen.add(key);
    }
    return configured.sort((a, b) =>
      a.category === b.category
        ? a.name.localeCompare(b.name)
        : a.category.localeCompare(b.category),
    );
  }, [inventory, records, state?.issuanceItems]);
  const stockSummary = categories
    .map((category) => {
      const rows = inventory.filter((item) => item.category === category);
      return {
        category,
        tracked: rows.length,
        beginning: rows.reduce((sum, item) => sum + item.beginning, 0),
        issued: rows.reduce((sum, item) => sum + item.issued, 0),
        onHand: rows.reduce((sum, item) => sum + item.onHand, 0),
      };
    })
    .filter((summary) => summary.tracked > 0);
  const uniforms = records.filter((record) => record.category === "Uniform");
  const welcomeKits = records.filter(
    (record) => record.category === "Welcome Kit",
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records
      .filter(
        (record) =>
          view === "All issuance" ||
          (view === "Uniforms" && record.category === "Uniform") ||
          (view === "Welcome kits" && record.category === "Welcome Kit"),
      )
      .filter(
        (record) => statusFilter === "All" || record.status === statusFilter,
      )
      .filter(
        (record) =>
          !needle ||
          [
            record.employeeName,
            record.employeeId,
            record.position,
            record.branch,
            record.item,
            record.size,
          ].some((value) => value?.toLowerCase().includes(needle)),
      )
      .sort((a, b) => {
        if (sort === "employee-a-z")
          return (
            a.employeeName.localeCompare(b.employeeName) ||
            a.item.localeCompare(b.item) ||
            b.updatedAt.localeCompare(a.updatedAt)
          );
        if (sort === "latest-issued")
          return (
            (b.issuedAt || b.receivedAt || b.updatedAt).localeCompare(
              a.issuedAt || a.receivedAt || a.updatedAt,
            ) || b.updatedAt.localeCompare(a.updatedAt)
          );
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [query, records, sort, statusFilter, view]);
  const editable =
    dataset === "real" &&
    ["Admin", "Talent Acquisition", "HR Generalist"].includes(
      state?.currentUser?.role || "",
    );

  if (!state) return <LoadingSkeleton />;

  async function importWorkbook(selected: File) {
    setBusy("Importing issuance workbook");
    try {
      const form = new FormData();
      form.set("file", selected);
      const response = await clientFetch("/api/issuance", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "The workbook could not be imported.");
      void refresh();
      notify(
        `${result.created} issuance record${result.created === 1 ? "" : "s"} imported${result.inventoryUpdated ? `; ${result.inventoryUpdated} on-hand stock item${result.inventoryUpdated === 1 ? "" : "s"} refreshed` : ""}${result.acknowledgmentsMarked ? `; ${result.acknowledgmentsMarked} historic acknowledgment${result.acknowledgmentsMarked === 1 ? "" : "s"} recorded` : ""}${result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}.`,
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy("");
      if (file.current) file.current.value = "";
    }
  }

  async function saveRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("Saving issuance record");
    try {
      const response = await clientFetch("/api/issuance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          category: form.get("category"),
          employeeName: form.get("employeeName"),
          employeeId: form.get("employeeId"),
          position: form.get("position"),
          branch: form.get("branch"),
          item: form.get("item"),
          size: form.get("size"),
          quantity: Number(form.get("quantity")),
          condition: form.get("condition"),
          status: form.get("status"),
          issuedAt: form.get("issuedAt"),
          receivedAt: form.get("receivedAt"),
          signed: form.get("signed") === "on",
          returnedAt: form.get("returnedAt"),
          remarks: form.get("remarks"),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "The issuance record could not be saved.");
      const record = result.record as IssuanceRecord;
      patchState((current) => ({
        ...current,
        issuance: [...(current.issuance || []), record],
        issuanceInventory:
          (result.inventory as IssuanceInventory[] | undefined) ||
          current.issuanceInventory,
      }));
      setAdding(false);
      notify("Issuance record saved.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  async function updateRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    setBusy("Updating issuance record");
    try {
      const response = await clientFetch("/api/issuance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: editing.id,
          category: form.get("category"),
          employeeName: form.get("employeeName"),
          employeeId: form.get("employeeId"),
          position: form.get("position"),
          branch: form.get("branch"),
          item: form.get("item"),
          size: form.get("size"),
          quantity: Number(form.get("quantity")),
          condition: form.get("condition"),
          status: form.get("status"),
          issuedAt: form.get("issuedAt"),
          signed: form.get("signed") === "on",
          receivedAt: form.get("receivedAt"),
          returnedAt: form.get("returnedAt"),
          remarks: form.get("remarks"),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(
          result.error || "The issuance record could not be updated.",
        );
      const record = result.record as IssuanceRecord;
      patchState((current) => ({
        ...current,
        issuance: (current.issuance || []).map((item) =>
          item.id === record.id ? record : item,
        ),
        issuanceInventory:
          (result.inventory as IssuanceInventory[] | undefined) ||
          current.issuanceInventory,
      }));
      setEditing(null);
      notify("Issuance update saved.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  async function saveStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = editingStock === "new" ? null : editingStock;
    setBusy("Saving on-hand inventory");
    try {
      const response = await clientFetch("/api/issuance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: existing ? "update-inventory" : "create-inventory",
          id: existing?.id,
          category: form.get("category"),
          role: form.get("role"),
          item: form.get("item"),
          size: form.get("size"),
          beginning: stockBeginning,
          issued: manualStockCountOverride ? manualStockIssued : 0,
          onHand: manualStockCountOverride ? manualStockOnHand : 0,
          manualCountOverride: manualStockCountOverride,
          updatedAt: form.get("updatedAt"),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "The stock item could not be saved.");
      const record = result.record as IssuanceInventory;
      patchState((current) => ({
        ...current,
        issuanceInventory: (current.issuanceInventory || []).some(
          (item) => item.id === record.id,
        )
          ? (current.issuanceInventory || []).map((item) =>
              item.id === record.id ? record : item,
            )
          : [...(current.issuanceInventory || []), record],
      }));
      setEditingStock(null);
      notify("Stock saved and the on-hand totals were refreshed.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="workspace-page issuance-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">HR OPERATIONS</div>
          <h1>Employee Issuance</h1>
          <p>
            Track uniforms and welcome kits after an employee joins Daily Joe.
          </p>
        </div>
        <div className="workspace-heading-side">
          <span className="workspace-heading-context">
            Employee asset and acknowledgment records
          </span>
          <div className="button-row">
            <input
              className="sr-only"
              ref={file}
              type="file"
              accept=".xlsx"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void importWorkbook(selected);
              }}
            />
            <Button
              variant="secondary"
              disabled={!editable || !!busy}
              title={
                !editable ? "An authorized HR role is required" : undefined
              }
              onClick={() => file.current?.click()}
            >
              <Upload size={16} />
              Import workbook
            </Button>
            <Button
              disabled={!editable || !!busy}
              title={
                !editable ? "An authorized HR role is required" : undefined
              }
              onClick={() => {
                setNewStatus("Issued");
                setNewReleasedAt(today());
                setAdding(true);
              }}
            >
              <Plus size={16} />
              Record issuance
            </Button>
          </div>
        </div>
      </div>
      <p className="workspace-heading-note">
        The import reads the updated Uniform and Welcome Kit sheets only. The
        workbook’s Monitoring sheet is deliberately excluded.
      </p>
      {busy && (
        <p className="notice" role="status">
          {busy}…
        </p>
      )}
      <div
        className="metrics-grid issuance-summary"
        aria-label="Employee issuance summary"
      >
        <MetricCard
          label="Uniform records"
          value={uniforms.length}
          note={`${employeeCount(uniforms)} employees with uniform history`}
          icon={<Shirt size={20} />}
          tone="featured"
        />
        <MetricCard
          label="Uniform pending"
          value={
            uniforms.filter((record) => record.status === "Pending").length
          }
          note="Items still awaiting issue or receipt"
          icon={<Clock3 size={20} />}
          tone="metric-review"
        />
        <MetricCard
          label="Welcome kit records"
          value={welcomeKits.length}
          note={`${employeeCount(welcomeKits)} employees with kit history`}
          icon={<Gift size={20} />}
          tone="hired"
        />
        <MetricCard
          label="Replacement review"
          value={
            records.filter((record) => record.status === "For Replacement")
              .length
          }
          note="Items HR marked for replacement"
          icon={<PackageCheck size={20} />}
          tone="metric-interviews"
        />
      </div>
      <Card className="issuance-stock-dashboard">
        <div className="section-heading">
          <div>
            <h2>Stock dashboard</h2>
            <p className="muted">
              Beginning is editable. Released / out and On hand automatically
              reconcile with issuance history.
            </p>
          </div>
          <Badge>{inventory.length} stock lines</Badge>
        </div>
        <div className="issuance-stock-summary">
          {stockSummary.map((summary) => (
            <div className="issuance-stock-summary-card" key={summary.category}>
              <Badge tone={summary.category === "Uniform" ? "blue" : "green"}>
                {summary.category}
              </Badge>
              <strong>{summary.onHand}</strong>
              <span>On hand</span>
              <small>
                Beginning {summary.beginning} · Out {summary.issued} ·{" "}
                {summary.tracked} item
                {summary.tracked === 1 ? "" : "s"}
              </small>
            </div>
          ))}
        </div>
      </Card>
      <Card className="issuance-inventory-card">
        <div className="section-heading">
          <div className="stock-register-identity">
            <span className="stock-register-icon">
              <PackageCheck size={19} />
            </span>
            <div>
              <span className="section-kicker">Stock control</span>
              <h2>Stock register</h2>
              <p className="muted">
                Physical count from the On Hand sheet. This is inventory
                control, not employee release history.
              </p>
            </div>
          </div>
          <div className="button-row">
            <Badge>{inventory.length} tracked items</Badge>
            <Button
              variant="secondary"
              disabled={!editable || !!busy}
              onClick={() => {
                setStockCategory("Uniform");
                setStockItem("");
                setStockBeginning(0);
                setManualStockCountOverride(false);
                setManualStockIssued(0);
                setManualStockOnHand(0);
                setEditingStock("new");
              }}
            >
              <Plus size={15} />
              Add stock item
            </Button>
          </div>
        </div>
        {inventory.length ? (
          <Table>
            <thead>
              <tr>
                <th>Stock group</th>
                <th>Item</th>
                <th>Size</th>
                <th>Beginning</th>
                <th>Released / out</th>
                <th>Current on hand</th>
                <th>Last stock count</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inventory
                .slice()
                .sort(
                  (a, b) =>
                    a.category.localeCompare(b.category) ||
                    a.item.localeCompare(b.item),
                )
                .map((stock) => (
                  <tr key={stock.id}>
                    <td>
                      <Badge
                        tone={stock.category === "Uniform" ? "blue" : "green"}
                      >
                        {stock.category}
                      </Badge>
                      <small className="cell-secondary">
                        {stock.role || "All employees"}
                      </small>
                    </td>
                    <td>
                      <strong>{stock.item}</strong>
                    </td>
                    <td>{stock.size || "—"}</td>
                    <td>{stock.beginning}</td>
                    <td>{stock.issued}</td>
                    <td>
                      <strong>{stock.onHand}</strong>
                    </td>
                    <td>{formatDate(stock.updatedAt, state.preferences)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        disabled={!editable || !!busy}
                        onClick={() => {
                          setStockCategory(stock.category);
                          setStockItem(stock.item);
                          setStockBeginning(stock.beginning);
                          setManualStockCountOverride(
                            !!stock.manualCountOverride,
                          );
                          setManualStockIssued(stock.issued);
                          setManualStockOnHand(stock.onHand);
                          setEditingStock(stock);
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-inline">
            Import the On Hand sheet to show current stock levels.
          </p>
        )}
      </Card>
      <Card className="issuance-workspace">
        <div className="issuance-history-heading">
          <div>
            <span className="section-kicker">ISSUANCE HISTORY</span>
            <h2>Employee issuance history</h2>
            <p className="muted">
              One row per employee release, receipt, and acknowledgment.
            </p>
          </div>
          <Badge>{filtered.length} release records</Badge>
        </div>
        <div className="issuance-toolbar">
          <Tabs
            items={["All issuance", "Uniforms", "Welcome kits"]}
            value={view}
            onChange={setView}
          />
          <Select
            aria-label="Filter issuance status"
            className="issuance-status-filter"
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as "All" | IssuanceStatus)
            }
          >
            <option value="All">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort employee issuance"
            className="issuance-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as IssuanceSort)}
          >
            <option value="latest-updated">Latest release update</option>
            <option value="latest-issued">Latest issued / received</option>
            <option value="employee-a-z">Employee A–Z</option>
          </Select>
          <div className="search-field issuance-search">
            <Search size={17} />
            <Input
              aria-label="Search employee issuance"
              placeholder="Search employee, branch, or item"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        {filtered.length ? (
          <Table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Issuance</th>
                <th>Size / quantity</th>
                <th>Issued / received</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.employeeName}</strong>
                    <small className="cell-secondary">
                      {[record.employeeId, record.position, record.branch]
                        .filter(Boolean)
                        .join(" · ") || "Employee details not recorded"}
                    </small>
                  </td>
                  <td>
                    <Badge
                      tone={record.category === "Uniform" ? "blue" : "green"}
                    >
                      {record.category}
                    </Badge>
                    <small className="cell-secondary">{record.item}</small>
                  </td>
                  <td>
                    <strong>{record.quantity}</strong>
                    <small className="cell-secondary">
                      {record.size
                        ? `Size ${record.size}`
                        : "Size not recorded"}
                      {record.condition ? ` · ${record.condition}` : ""}
                    </small>
                  </td>
                  <td>
                    <strong>
                      {record.issuedAt
                        ? formatDate(record.issuedAt, state.preferences)
                        : "Not issued"}
                    </strong>
                    <small className="cell-secondary">
                      {record.receivedAt
                        ? `Received ${formatDate(record.receivedAt, state.preferences)}`
                        : "Receipt pending"}
                    </small>
                  </td>
                  <td>
                    <StatusBadge status={record.status} />
                    <small className="cell-secondary">
                      {record.signed
                        ? "Acknowledgment recorded"
                        : "Acknowledgment pending"}
                    </small>
                  </td>
                  <td>
                    <Button
                      variant="secondary"
                      disabled={!editable || !!busy}
                      onClick={() => setEditing(record)}
                    >
                      Update
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title={
              records.length
                ? "No issuance records match"
                : "No issuance records yet"
            }
            description={
              records.length
                ? "Try a different view or search phrase."
                : "Import the current Uniform and Welcome Kit workbook, or record an issuance manually."
            }
          />
        )}
      </Card>
      {adding && (
        <Modal
          title="Record employee issuance"
          busy={!!busy}
          onClose={() => setAdding(false)}
        >
          <form className="form-stack" onSubmit={saveRecord}>
            <div className="form-grid">
              <Field label="Category">
                <Select
                  name="category"
                  value={newCategory}
                  onChange={(event) =>
                    setNewCategory(event.target.value as IssuanceCategory)
                  }
                >
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Employee name">
                <Input name="employeeName" required />
              </Field>
              <Field label="Employee ID">
                <Input name="employeeId" />
              </Field>
              <Field label="Position">
                <Input name="position" />
              </Field>
              <Field label="Branch / location">
                <Input name="branch" />
              </Field>
              <Field label="Item">
                <Select name="item" required defaultValue="">
                  <option value="" disabled>
                    Select configured item
                  </option>
                  {catalog
                    .filter((item) => item.category === newCategory)
                    .map((item) => (
                      <option key={item.id} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                </Select>
                <small className="field-note">
                  Configure items in Settings → Employee Issuance.
                </small>
              </Field>
              <Field label="Size">
                <Input name="size" placeholder="Optional for non-sized items" />
              </Field>
              <Field label="Quantity">
                <Input
                  name="quantity"
                  type="number"
                  min="1"
                  defaultValue="1"
                  required
                />
              </Field>
              <Field label="Condition">
                <Input name="condition" placeholder="New, used, replacement" />
              </Field>
              <Field label="Status">
                <Select
                  name="status"
                  value={newStatus}
                  onChange={(event) =>
                    setNewStatus(
                      statusAfterReleaseDate(
                        event.target.value as IssuanceStatus,
                        newReleasedAt,
                      ),
                    )
                  }
                >
                  {statuses.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Date released">
                <Input
                  name="issuedAt"
                  type="date"
                  value={newReleasedAt}
                  onChange={(event) => {
                    setNewReleasedAt(event.target.value);
                    setNewStatus((status) =>
                      statusAfterReleaseDate(status, event.target.value),
                    );
                  }}
                />
                <small className="muted">
                  A release date changes Pending to Issued.
                </small>
              </Field>
              <Field label="Date received">
                <Input name="receivedAt" type="date" />
              </Field>
            </div>
            <label className="check-row">
              <input name="signed" type="checkbox" defaultChecked /> Issuance
              acknowledgment signed
            </label>
            <Field label="Remarks">
              <RichTextEditor name="remarks" rows={3} />
            </Field>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!!busy}>
                Save issuance
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit employee issuance"
          busy={!!busy}
          onClose={() => setEditing(null)}
        >
          <form className="form-stack" onSubmit={updateRecord}>
            <div className="issuance-record-heading">
              <CheckCircle2 size={18} />
              <span>
                <strong>{editing.employeeName}</strong>
                <small>
                  {editing.category} · {editing.item}
                </small>
              </span>
            </div>
            <div className="form-grid">
              <Field label="Category">
                <Select
                  name="category"
                  value={editing.category}
                  onChange={(event) => {
                    const category = event.target.value as IssuanceCategory;
                    const replacement = catalog.find(
                      (item) => item.category === category,
                    )?.name;
                    setEditing({
                      ...editing,
                      category,
                      item: replacement || editing.item,
                    });
                  }}
                >
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Employee name">
                <Input
                  name="employeeName"
                  required
                  defaultValue={editing.employeeName}
                />
              </Field>
              <Field label="Employee ID">
                <Input
                  name="employeeId"
                  defaultValue={editing.employeeId || ""}
                />
              </Field>
              <Field label="Position">
                <Input name="position" defaultValue={editing.position || ""} />
              </Field>
              <Field label="Branch / location">
                <Input name="branch" defaultValue={editing.branch || ""} />
              </Field>
              <Field label="Item">
                <Select
                  name="item"
                  value={editing.item}
                  required
                  onChange={(event) =>
                    setEditing({ ...editing, item: event.target.value })
                  }
                >
                  {!catalog.some(
                    (item) =>
                      item.category === editing.category &&
                      item.name === editing.item,
                  ) && <option value={editing.item}>{editing.item}</option>}
                  {catalog
                    .filter((item) => item.category === editing.category)
                    .map((item) => (
                      <option key={item.id} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Size">
                <Input name="size" defaultValue={editing.size || ""} />
              </Field>
              <Field label="Quantity">
                <Input
                  name="quantity"
                  type="number"
                  min="1"
                  required
                  defaultValue={editing.quantity}
                />
              </Field>
              <Field label="Condition">
                <Input
                  name="condition"
                  defaultValue={editing.condition || ""}
                />
              </Field>
              <Field label="Status">
                <Select
                  name="status"
                  value={statusAfterReleaseDate(
                    editing.status,
                    editing.issuedAt,
                  )}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      status: statusAfterReleaseDate(
                        event.target.value as IssuanceStatus,
                        editing.issuedAt,
                      ),
                    })
                  }
                >
                  {statuses.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Date released">
                <Input
                  name="issuedAt"
                  type="date"
                  value={editing.issuedAt || ""}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      issuedAt: event.target.value,
                      status: statusAfterReleaseDate(
                        editing.status,
                        event.target.value,
                      ),
                    })
                  }
                />
                <small className="muted">
                  A release date changes Pending to Issued.
                </small>
              </Field>
              <Field label="Date received">
                <Input
                  name="receivedAt"
                  type="date"
                  defaultValue={editing.receivedAt || ""}
                />
              </Field>
              <Field label="Date returned">
                <Input
                  name="returnedAt"
                  type="date"
                  defaultValue={editing.returnedAt || ""}
                />
              </Field>
            </div>
            <label className="check-row">
              <input
                name="signed"
                type="checkbox"
                defaultChecked={editing.signed}
              />{" "}
              Issuance acknowledgment signed
            </label>
            <Field label="Remarks">
              <RichTextEditor
                name="remarks"
                rows={3}
                defaultValue={editing.remarks || ""}
              />
            </Field>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!!busy}>
                Save update
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {editingStock && (
        <Modal
          title={editingStock === "new" ? "Add stock item" : "Edit stock item"}
          busy={!!busy}
          onClose={() => setEditingStock(null)}
        >
          <form className="form-stack" onSubmit={saveStock}>
            <div className="form-grid">
              <Field label="Category">
                <Select
                  name="category"
                  value={stockCategory}
                  onChange={(event) => {
                    setStockCategory(event.target.value as IssuanceCategory);
                    setStockItem("");
                  }}
                >
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Role / stock group">
                <Input
                  name="role"
                  defaultValue={
                    editingStock === "new" ? "" : editingStock.role || ""
                  }
                  placeholder="Barista, Admin, all employees"
                />
              </Field>
              <Field label="Item">
                <Select
                  name="item"
                  required
                  value={stockItem}
                  onChange={(event) => setStockItem(event.target.value)}
                >
                  <option value="" disabled>
                    Select configured stock item
                  </option>
                  {catalog
                    .filter((item) => item.category === stockCategory)
                    .map((item) => (
                      <option key={item.id} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                </Select>
                <small className="field-note">
                  Maintain this list in Settings → Employee Issuance.
                </small>
              </Field>
              <Field label="Size">
                <Input
                  name="size"
                  defaultValue={
                    editingStock === "new" ? "" : editingStock.size || ""
                  }
                  placeholder="Optional for non-sized items"
                />
              </Field>
              <Field label="Beginning">
                <Input
                  name="beginning"
                  type="number"
                  min="0"
                  required
                  value={stockBeginning}
                  onChange={(event) =>
                    setStockBeginning(Math.max(0, Number(event.target.value)))
                  }
                />
              </Field>
              {manualStockCountOverride ? (
                <>
                  <Field label="Released / out (manual override)">
                    <Input
                      name="issued"
                      type="number"
                      min="0"
                      required
                      value={manualStockIssued}
                      onChange={(event) =>
                        setManualStockIssued(
                          Math.max(0, Number(event.target.value)),
                        )
                      }
                    />
                  </Field>
                  <Field label="Current on hand (manual override)">
                    <Input
                      name="onHand"
                      type="number"
                      min="0"
                      required
                      value={manualStockOnHand}
                      onChange={(event) =>
                        setManualStockOnHand(
                          Math.max(0, Number(event.target.value)),
                        )
                      }
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Released / out">
                    <Input
                      name="automaticIssued"
                      value={automaticStockOut}
                      readOnly
                    />
                  </Field>
                  <Field label="Current on hand">
                    <Input
                      name="automaticOnHand"
                      value={Math.max(0, stockBeginning - automaticStockOut)}
                      readOnly
                    />
                  </Field>
                </>
              )}
              <Field label="Updated on">
                <Input
                  name="updatedAt"
                  type="date"
                  defaultValue={
                    editingStock === "new"
                      ? today()
                      : editingStock.updatedAt.slice(0, 10)
                  }
                />
              </Field>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={manualStockCountOverride}
                onChange={(event) =>
                  setManualStockCountOverride(event.target.checked)
                }
              />
              Use a verified physical-count override for this stock line
            </label>
            <p className="fine-print">
              Automatic is the default: Released / out follows active issuance
              history and Current on hand is Beginning minus Released / out. Use
              an override only to retain a documented physical-count correction.
            </p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditingStock(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!!busy}>
                Save stock item
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
