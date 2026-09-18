"use client";
import { useState } from "react";
import type { User, Location, QualificationRule } from "@/types";
import { useApp } from "./provider";
import { Button, Card, Field, Input, Select, Modal, Badge } from "./ui";
import { QualificationEditor } from "./qualification-editor";
export function UsersSettings() {
  const { state, update } = useApp();
  const [editing, setEditing] = useState<User | null>(null);
  if (!state) return null;
  return (
    <Card>
      <div className="card-heading">
        <h2>Users & Permissions</h2>
        <Button
          disabled={state.currentUser?.role !== "Admin"}
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
          Job titles are displayed on profiles. Permission roles control what an
          account can do. Google verifies identity at sign-in.
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
              disabled={state.currentUser?.role !== "Admin"}
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
            <Button type="submit">Confirm access changes</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function LocationsSettings() {
  const { state, update } = useApp();
  const [editing, setEditing] = useState<Location | null>(null);
  if (!state) return null;
  return (
    <Card>
      <div className="card-heading">
        <h2>Locations</h2>
        <Button
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
        {state.locations?.map((l) => (
          <div className="permission-row" key={l.id}>
            <div>
              <strong>{l.name}</strong>
              <p>
                {l.city} · {l.province} · {l.active ? "Active" : "Inactive"}
              </p>
            </div>
            <Button variant="secondary" onClick={() => setEditing(l)}>
              Edit
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <Modal title="Branch / location" onClose={() => setEditing(null)}>
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
            <Button type="submit">Save location</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function QualificationsSettings() {
  const { state, update } = useApp();
  const [editing, setEditing] = useState<string | null>(null),
    [rules, setRules] = useState<QualificationRule[]>([]);
  if (!state) return null;
  const q = state.qualifications.find((q) => q.id === editing);
  return (
    <Card>
      <div className="card-heading">
        <h2>Job & Qualification Templates</h2>
        <Badge>HR-defined criteria</Badge>
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
      {q && (
        <Modal
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
              <textarea name="questions" defaultValue={q.questions} />
            </Field>
            <p>
              HR records actual interview answers. The system does not infer
              answers from resumes.
            </p>
            <Button type="submit">Save template</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
export function PreferencesSettings() {
  const { state, update } = useApp();
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
            await update((s) => ({
              ...s,
              intakeQuery: String(f.get("query")),
              preferences: {
                ...s.preferences,
                compact: f.get("compact") === "on",
                theme: f.get("theme") as "light" | "dark",
                timezone: String(f.get("timezone")),
                dateFormat: String(f.get("dateFormat")),
                notifications: f.get("notifications") === "on",
              },
            }));
          }}
        >
          <Field label="Theme">
            <Select name="theme" defaultValue={state.preferences.theme}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
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
            <Input name="query" defaultValue={state.intakeQuery} />
          </Field>
          <p>
            Only matching messages are previewed. Use Gmail subject, attachment,
            or date filters to keep intake relevant.
          </p>
          <Button type="submit">Save preferences</Button>
          <div className="info-banner">
            <h3>Import policy</h3>
            <p>
              {state.applications.length} / {state.importLimit || 100}{" "}
              applicants imported. Applications display 20 records per page.
            </p>
          </div>
        </form>
      </Card>
      {process.env.NODE_ENV !== "production" && <DemoDataSettings />}
    </>
  );
}

function DemoDataSettings() {
  const { state, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  async function run(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      const response = await fetch("/api/demo", { method });
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error || "Unable to update demo data.");
      await refresh();
      notify(
        method === "POST"
          ? `Added ${data.imported} fictional demo applications.`
          : `Removed ${data.removed} demo applications.`,
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Unable to update demo data.",
      );
    } finally {
      setBusy(false);
    }
  }
  const count =
    state?.applications.filter((a) => a.source === "Demo").length || 0;
  return (
    <Card className="padded demo-data-card">
      <div className="card-heading">
        <div>
          <h2>Local demo data</h2>
          <p>
            Load ten fictional applications to walk through every workflow. Demo
            records are never enabled on production.
          </p>
        </div>
        <Badge>Development only</Badge>
      </div>
      <p className="muted">{count} demo applications currently loaded.</p>
      <div className="button-row">
        <Button disabled={busy} onClick={() => void run("POST")}>
          {busy ? "Working…" : "Load 10 demo records"}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || count === 0}
          onClick={() => void run("DELETE")}
        >
          Clear demo records
        </Button>
      </div>
    </Card>
  );
}
