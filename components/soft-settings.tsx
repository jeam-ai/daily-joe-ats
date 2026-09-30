"use client";
import { clientFetch, requestJson } from "@/lib/client-request";
import { useEffect, useRef, useState } from "react";
import type {
  IssuanceCatalogItem,
  IssuanceCategory,
  Location,
  QualificationRule,
  User,
} from "@/types";
import { useApp } from "./provider";
import { Button, Card, Field, Input, Select, Modal, Badge } from "./ui";
import { QualificationEditor } from "./qualification-editor";
import { RichTextEditor } from "./rich-text";
import { applicationSearchQuery } from "@/lib/intake-detector";
export function UsersSettings() {
  const { state, update, saving } = useApp();
  const [editing, setEditing] = useState<User | null>(null);
  if (!state) return null;
  return (
    <Card>
      <div className="card-heading">
        <h2>Users & Permissions</h2>
        <Button
          disabled={saving || state.currentUser?.role !== "Admin"}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              email: "",
              name: "",
              role: "Viewer",
              title: "",
              active: true,
            })
          }
        >
          + Authorize user
        </Button>
      </div>
      <div className="padded">
        <p>
          Only administrators can change users, locations, and recruitment
          templates. Job titles are displayed on profiles. Permission roles
          control what an account can do. Google verifies identity at sign-in.
        </p>
        {state.users?.map((u) => (
          <div className="permission-row" key={u.id}>
            <div>
              <strong>{u.name || u.email}</strong>
              <p>
                {u.email} · {u.title}
              </p>
              <Badge>
                {u.role} · {u.active ? "Active" : "Inactive"}
              </Badge>
            </div>
            <Button
              variant="secondary"
              disabled={saving || state.currentUser?.role !== "Admin"}
              onClick={() => setEditing(u)}
            >
              Edit access
            </Button>
          </div>
        ))}
        <div className="role-guide" aria-label="Permission role guide">
          <div>
            <strong>Admin</strong>
            <span>Workspace configuration and user access</span>
          </div>
          <div>
            <strong>Talent Acquisition</strong>
            <span>Recruitment workflow and applicant communication</span>
          </div>
          <div>
            <strong>HR Generalist</strong>
            <span>Recruitment review and applicant communication</span>
          </div>
          <div>
            <strong>Office Assistant</strong>
            <span>Operational updates for assigned applicants</span>
          </div>
          <div>
            <strong>Viewer</strong>
            <span>Read-only access to workspace records</span>
          </div>
        </div>
      </div>
      {editing && (
        <Modal
          busy={saving}
          title="Confirm authorized user access"
          onClose={() => setEditing(null)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const user = {
                ...editing,
                email: String(f.get("email")).trim().toLowerCase(),
                title: String(f.get("title")),
                role: f.get("role") as User["role"],
                active: f.get("active") === "on",
              };
              if (
                await update(
                  (s) => ({
                    ...s,
                    users: s.users?.some((u) => u.id === user.id)
                      ? s.users.map((u) => (u.id === user.id ? user : u))
                      : [...(s.users || []), user],
                  }),
                  true,
                )
              )
                setEditing(null);
            }}
          >
            <Field label="Google account email">
              <Input
                type="email"
                name="email"
                defaultValue={editing.email}
                required
              />
            </Field>
            <Field label="Job title">
              <Input name="title" defaultValue={editing.title} required />
            </Field>
            <Field label="Permission role">
              <Select name="role" defaultValue={editing.role}>
                {[
                  "Admin",
                  "Talent Acquisition",
                  "HR Generalist",
                  "Office Assistant",
                  "Viewer",
                ].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <label className="checkbox-row">
              <input
                name="active"
                type="checkbox"
                defaultChecked={editing.active}
              />
              Allow this account to sign in
            </label>
            <p>
              Confirming changes this account’s access to applicant information.
            </p>
            <Button type="submit" disabled={saving}>
              Confirm access changes
            </Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function LocationsSettings() {
  const { state, update, saving, refresh, notify, dataset } = useApp();
  const [editing, setEditing] = useState<Location | null>(null);
  const geographySynced = useRef(false);
  useEffect(() => {
    if (
      geographySynced.current ||
      dataset !== "real" ||
      state?.currentUser?.role !== "Admin"
    )
      return;
    geographySynced.current = true;
    void requestJson<{ updated: number }>("/api/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "normalize-locations" }),
    })
      .then(async ({ updated }) => {
        if (!updated) return;
        await refresh();
        notify(
          `Branch geography updated; ${updated} location and assignment records refreshed.`,
        );
      })
      .catch(() => undefined);
  }, [dataset, notify, refresh, state?.currentUser?.role]);
  if (!state) return null;
  return (
    <Card>
      <div className="card-heading">
        <h2>Locations</h2>
        <Button
          disabled={saving || state.currentUser?.role !== "Admin"}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              name: "",
              city: "",
              province: "",
              active: true,
            })
          }
        >
          + Add location
        </Button>
      </div>
      <div className="padded">
        <p className="fine-print">
          Branch city and province are verified from the official branch
          directory. Nearby residence matching assigns an unassigned branch only
          when one branch is unambiguous; HR assignments are preserved.
        </p>
        {state.locations?.map((l) => (
          <div className="permission-row" key={l.id}>
            <div>
              <strong>{l.name}</strong>
              <p>
                {l.city} · {l.province} · {l.active ? "Active" : "Inactive"}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={saving || state.currentUser?.role !== "Admin"}
              onClick={() => setEditing(l)}
            >
              Edit
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <Modal
          busy={saving}
          title="Branch / location"
          onClose={() => setEditing(null)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const location = {
                ...editing,
                name: String(f.get("name")),
                city: String(f.get("city")),
                province: String(f.get("province")),
                active: f.get("active") === "on",
              };
              if (
                await update((s) => ({
                  ...s,
                  locations: s.locations?.some((l) => l.id === location.id)
                    ? s.locations.map((l) =>
                        l.id === location.id ? location : l,
                      )
                    : [...(s.locations || []), location],
                }))
              )
                setEditing(null);
            }}
          >
            {["name", "city", "province"].map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                <Input
                  name={k}
                  required
                  defaultValue={editing[k as "name" | "city" | "province"]}
                />
              </Field>
            ))}
            <label className="checkbox-row">
              <input
                name="active"
                type="checkbox"
                defaultChecked={editing.active}
              />
              Active location
            </label>
            <Button type="submit" disabled={saving}>
              Save location
            </Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function QualificationsSettings() {
  const { state, update, saving } = useApp();
  const [adding, setAdding] = useState(false),
    [positionError, setPositionError] = useState("");
  const [editing, setEditing] = useState<string | null>(null),
    [rules, setRules] = useState<QualificationRule[]>([]);
  if (!state) return null;
  const q = state.qualifications.find((q) => q.id === editing);
  return (
    <Card>
      <div className="card-heading">
        <h2>Job & Qualification Templates</h2>
        <Button
          disabled={saving || state.currentUser?.role !== "Admin"}
          onClick={() => {
            setPositionError("");
            setAdding(true);
          }}
        >
          + Add Position
        </Button>
      </div>
      <div className="padded">
        {state.qualifications.map((q) => (
          <div key={q.id} className="permission-row">
            <div>
              <h3>{q.position}</h3>
              {q.rules?.length ? (
                <ul>
                  {q.rules.map((r) => (
                    <li key={r.id}>
                      {r.label} · {r.kind}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No criteria configured yet.</p>
              )}
            </div>
            <Button
              variant="secondary"
              disabled={saving || state.currentUser?.role !== "Admin"}
              onClick={() => {
                setEditing(q.id);
                setRules(q.rules || []);
              }}
            >
              Edit checklist
            </Button>
          </div>
        ))}
      </div>
      {adding && (
        <Modal
          title="Add Position"
          busy={saving}
          onClose={() => setAdding(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const position = String(
                new FormData(e.currentTarget).get("position") || "",
              ).trim();
              if (
                state.qualifications.some(
                  (q) => q.position.toLowerCase() === position.toLowerCase(),
                )
              ) {
                setPositionError("This position already exists.");
                return;
              }
              if (
                await update((s) => ({
                  ...s,
                  qualifications: [
                    ...s.qualifications,
                    {
                      id: crypto.randomUUID(),
                      position,
                      minimum: "",
                      preferred: "",
                      criteria: "",
                      questions: "",
                      rules: [],
                    },
                  ],
                }))
              )
                setAdding(false);
            }}
          >
            <Field label="Position name">
              <Input name="position" required maxLength={200} />
            </Field>
            <p>
              Configure its qualifications after adding it. It will be available
              for applicants and hiring needs.
            </p>
            {positionError && (
              <p role="alert" className="error-banner">
                {positionError}
              </p>
            )}
            <Button type="submit" disabled={saving}>
              Add Position
            </Button>
          </form>
        </Modal>
      )}
      {q && (
        <Modal
          busy={saving}
          title={`${q.position} qualifications`}
          onClose={() => setEditing(null)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await update((s) => ({
                  ...s,
                  qualifications: s.qualifications.map((v) =>
                    v.id === q.id
                      ? { ...v, rules, questions: String(f.get("questions")) }
                      : v,
                  ),
                }))
              )
                setEditing(null);
            }}
          >
            <QualificationEditor value={rules} onChange={setRules} />
            <Field label="Interview reference questions">
              <RichTextEditor
                name="questions"
                defaultValue={q.questions}
                rows={4}
                placeholder="Add interview reference questions"
              />
            </Field>
            <p>
              HR records actual interview answers. The system does not infer
              answers from resumes.
            </p>
            <Button type="submit" disabled={saving}>
              Save template
            </Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function IssuanceSettings() {
  const { state, update, saving } = useApp();
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<
    Record<string, Partial<IssuanceCatalogItem>>
  >({});
  if (!state) return null;
  const admin = state.currentUser?.role === "Admin";
  const items = state.issuanceItems || [];
  const setDraft = (id: string, patch: Partial<IssuanceCatalogItem>) =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  const save = async (item: IssuanceCatalogItem) => {
    const draft = { ...item, ...drafts[item.id] };
    if (!draft.name?.trim()) return;
    const saved = await update((workspace) => ({
      ...workspace,
      issuanceItems: (workspace.issuanceItems || []).map((current) =>
        current.id === item.id
          ? { ...draft, name: draft.name!.trim() }
          : current,
      ),
    }));
    if (saved)
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
  };
  return (
    <Card>
      <div className="card-heading">
        <div>
          <h2>Employee Issuance Items</h2>
          <p>
            Maintain the dropdown list HR uses for uniforms, kits, and
            equipment.
          </p>
        </div>
        <Button disabled={!admin || saving} onClick={() => setAdding(true)}>
          + Add item
        </Button>
      </div>
      <div className="padded form-stack issuance-item-settings">
        {items.map((item) => {
          const draft = { ...item, ...drafts[item.id] };
          const changed = !!drafts[item.id];
          return (
            <div className="issuance-item-setting" key={item.id}>
              <Select
                aria-label={`${item.name} category`}
                disabled={!admin || saving}
                value={draft.category}
                onChange={(event) =>
                  setDraft(item.id, {
                    category: event.target.value as IssuanceCategory,
                  })
                }
              >
                <option>Uniform</option>
                <option>Welcome Kit</option>
                <option>Other</option>
              </Select>
              <Input
                aria-label="Issuance item name"
                disabled={!admin || saving}
                value={draft.name}
                onChange={(event) =>
                  setDraft(item.id, { name: event.target.value })
                }
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={!admin || saving}
                  checked={draft.active}
                  onChange={(event) =>
                    setDraft(item.id, { active: event.target.checked })
                  }
                />
                Active
              </label>
              <Button
                type="button"
                variant="secondary"
                disabled={!admin || saving || !changed || !draft.name?.trim()}
                onClick={() => void save(item)}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          );
        })}
        {!items.length && (
          <p className="muted">No issuance items configured yet.</p>
        )}
        <p className="fine-print">
          Inactive items remain in history but no longer appear when HR records
          a new issue.
        </p>
      </div>
      {adding && (
        <Modal
          title="Add issuance item"
          busy={saving}
          onClose={() => setAdding(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const item: IssuanceCatalogItem = {
                id: crypto.randomUUID(),
                category: form.get("category") as IssuanceCategory,
                name: String(form.get("name") || "").trim(),
                active: true,
              };
              if (!item.name) return;
              if (
                await update((workspace) => ({
                  ...workspace,
                  issuanceItems: [...(workspace.issuanceItems || []), item],
                }))
              )
                setAdding(false);
            }}
          >
            <Field label="Category">
              <Select name="category" defaultValue="Uniform">
                <option>Uniform</option>
                <option>Welcome Kit</option>
                <option>Other</option>
              </Select>
            </Field>
            <Field label="Item name">
              <Input name="name" required placeholder="Example: Polo Shirt" />
            </Field>
            <div className="modal-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!admin || saving}>
                Save item
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function PreferencesSettings() {
  const { state, refresh, notify, dataset } = useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!state) return null;
  return (
    <>
      <Card>
        <div className="card-heading">
          <h2>System Preferences</h2>
          <Badge tone="blue">Workspace</Badge>
        </div>
        <form
          className="padded form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setSaving(true);
            setError("");
            try {
              await requestJson("/api/workspace", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  dataset,
                  intakePaused:
                    state.currentUser?.role === "Admin" && dataset === "real"
                      ? f.get("intakePaused") === "on"
                      : undefined,
                  intakeQuery:
                    state.currentUser?.role === "Admin" && dataset === "real"
                      ? String(f.get("query"))
                      : undefined,
                  preferences: {
                    ...state.preferences,
                    compact: f.get("compact") === "on",
                    theme: f.get("theme") as "light" | "dark" | "system",
                    timezone: String(f.get("timezone")),
                    dateFormat: String(f.get("dateFormat")),
                    notifications: f.get("notifications") === "on",
                  },
                }),
              });
              await refresh();
              notify("Preferences saved.");
            } catch (e) {
              const message = (e as Error).message;
              setError(message);
              notify(message, "error");
            } finally {
              setSaving(false);
            }
          }}
        >
          <Field label="Theme">
            <Select name="theme" defaultValue={state.preferences.theme}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </Select>
          </Field>
          <Field label="Timezone">
            <Select name="timezone" defaultValue={state.preferences.timezone}>
              <option>Asia/Manila</option>
              <option>Asia/Singapore</option>
              <option>UTC</option>
            </Select>
          </Field>
          <Field label="Date format">
            <Select
              name="dateFormat"
              defaultValue={state.preferences.dateFormat}
            >
              <option value="en-PH">Day / month / year</option>
              <option value="en-US">Month / day / year</option>
            </Select>
          </Field>
          <label className="checkbox-row">
            <input
              name="compact"
              type="checkbox"
              defaultChecked={state.preferences.compact}
            />
            Compact tables
          </label>
          <label className="checkbox-row">
            <input
              name="notifications"
              type="checkbox"
              defaultChecked={state.preferences.notifications !== false}
            />
            Show notification indicators
          </label>
          <Field label="Gmail application search filter (Admin)">
            <Input
              disabled={
                state.currentUser?.role !== "Admin" || dataset === "demo"
              }
              name="query"
              defaultValue={applicationSearchQuery(state.intakeQuery)}
            />
            <small className="muted">
              The default finds applications without Gmail labels. Messages are
              checked for application intent or resume evidence before import.
            </small>
          </Field>
          <label className="checkbox-label">
            <input
              name="intakePaused"
              type="checkbox"
              defaultChecked={!!state.intakePaused}
              disabled={
                state.currentUser?.role !== "Admin" || dataset !== "real"
              }
            />{" "}
            Pause automatic Gmail intake
          </label>
          <p className="fine-print">
            Keep this enabled until you are ready to re-sync applications.
            Uncheck and save to resume intake.
          </p>
          <p>
            Only matching messages are previewed. Use Gmail subject, attachment,
            or date filters to keep intake relevant.
          </p>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving preferences…" : "Save preferences"}
          </Button>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <div className="info-banner">
            <h3>Import policy</h3>
            <p>
              {state.applicationSummary?.real.active || 0} / 100 active
              applicants. Applications display 20 records per page.
            </p>
          </div>
        </form>
      </Card>
    </>
  );
}
