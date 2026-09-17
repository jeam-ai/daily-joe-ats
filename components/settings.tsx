"use client";
import Link from "next/link";
import { useState } from "react";
import {
  UserRound,
  Plug,
  ClipboardList,
  FileCheck2,
  Mail,
  UsersRound,
  SlidersHorizontal,
  Plus,
  Trash2,
  Save,
} from "lucide-react";
import { useApp } from "./provider";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  LoadingSkeleton,
  Modal,
  Avatar,
} from "./ui";
import { GmailSettings } from "./gmail-settings";
import {
  UsersSettings,
  LocationsSettings,
  QualificationsSettings,
  PreferencesSettings,
} from "./soft-settings";
const sections = [
  ["account", "Account", UserRound],
  ["integrations", "Integrations", Plug],
  ["qualifications", "Job & Qualification Templates", ClipboardList],
  ["requirements", "Pre-employment Requirements", FileCheck2],
  ["email-templates", "Email Templates", Mail],
  ["locations", "Locations", ClipboardList],
  ["users", "Users & Permissions", UsersRound],
  ["preferences", "System Preferences", SlidersHorizontal],
] as const;
export function Settings({ section = "integrations" }: { section?: string }) {
  const { state, update, notify } = useApp();
  const [selected, setSelected] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  if (!state) return <LoadingSkeleton />;
  const qualification =
    state.qualifications.find((t) => t.id === selected) ||
    state.qualifications[0];
  const template =
    state.emailTemplates.find((t) => t.id === selected) ||
    state.emailTemplates[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE IT WORK FOR YOUR TEAM</div>
          <h1>Settings</h1>
          <p>A well-organized workspace for thoughtful hiring.</p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(([slug, label, Icon]) => (
            <Link
              href={`/settings/${slug}`}
              key={slug}
              className={section === slug ? "active" : ""}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          {section === "integrations" && <GmailSettings />}
          {section === "account" && (
            <Card>
              <div className="card-heading">
                <h2>Your account</h2>
                <Badge>{state.currentUser?.role}</Badge>
              </div>
              <div className="padded form-stack">
                <Avatar
                  name={state.currentUser?.name || "HR"}
                  imageUrl={state.currentUser?.avatarUrl}
                />
                <h3>{state.currentUser?.name}</h3>
                <p>{state.currentUser?.email}</p>
                <p>{state.currentUser?.title}</p>
                <p>
                  Official careers mailbox: careers@daily-joe.com · Talent
                  Acquisition Specialist
                </p>
                <a className="text-link" href="/api/auth/google">
                  Refresh Google identity
                </a>
                <a className="text-link" href="/api/auth/logout">
                  Sign out
                </a>
              </div>
            </Card>
          )}
          {section === "qualifications" && <QualificationsSettings />}
          {section === "requirements" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Pre-employment Requirements</h2>
                  <p>Manage the default checklist for future applications.</p>
                </div>
              </div>
              <div className="padded form-stack">
                {state.requirementTemplates.map((r) => (
                  <div className="requirement-template" key={r.id}>
                    <Input
                      aria-label="Requirement name"
                      defaultValue={r.name}
                      key={r.id + r.name}
                      onBlur={(e) =>
                        update((s) => ({
                          ...s,
                          requirementTemplates: s.requirementTemplates.map(
                            (item) =>
                              item.id === r.id
                                ? { ...item, name: e.target.value }
                                : item,
                          ),
                        }))
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${r.name}`}
                      onClick={() => setRemove(r.id)}
                    >
                      <Trash2 size={17} />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  onClick={() =>
                    update((s) => ({
                      ...s,
                      requirementTemplates: [
                        ...s.requirementTemplates,
                        { id: crypto.randomUUID(), name: "New requirement" },
                      ],
                    }))
                  }
                >
                  <Plus size={16} />
                  Add requirement
                </Button>
                <p className="fine-print">
                  Changes save to the recruitment workspace. Existing applicant
                  checklists keep their historical requirements.
                </p>
              </div>
            </Card>
          )}
          {section === "email-templates" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Email Templates</h2>
                  <p>Make each next step clear and personal.</p>
                </div>
                <Badge>Explicit send confirmation</Badge>
              </div>
              <div className="padded">
                <Field label="Template">
                  <Select
                    value={template.id}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {state.emailTemplates.map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <form
                  key={template.id}
                  className="form-stack spaced"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    update((s) => ({
                      ...s,
                      emailTemplates: s.emailTemplates.map((t) =>
                        t.id === template.id
                          ? {
                              ...t,
                              subject: String(d.get("subject")),
                              body: String(d.get("body")),
                            }
                          : t,
                      ),
                    }));
                  }}
                >
                  <Field label="Subject">
                    <Input
                      name="subject"
                      required
                      defaultValue={template.subject}
                    />
                  </Field>
                  <Field label="Message">
                    <textarea
                      name="body"
                      required
                      rows={10}
                      defaultValue={template.body}
                    />
                  </Field>
                  <div className="variable-list">
                    {[
                      "applicant_name",
                      "position",
                      "location",
                      "interview_date",
                      "interview_time",
                      "company_name",
                    ].map((v) => (
                      <code key={v}>{`{{${v}}}`}</code>
                    ))}
                  </div>
                  <Button type="submit">
                    <Save size={16} />
                    Save template
                  </Button>
                </form>
              </div>
            </Card>
          )}
          {section === "users" && <UsersSettings />}
          {section === "preferences" && <PreferencesSettings />}
          {section === "locations" && <LocationsSettings />}
          {!sections.some(([slug]) => slug === section) && (
            <Card className="padded">
              <h2>Settings section not found</h2>
              <Link href="/settings/integrations">Open integrations</Link>
            </Card>
          )}
        </div>
      </div>
      {remove && (
        <Modal
          title="Remove checklist requirement?"
          onClose={() => setRemove(null)}
        >
          <p>
            This changes the default template. Existing applicant records stay
            intact.
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                update((s) => ({
                  ...s,
                  requirementTemplates: s.requirementTemplates.filter(
                    (r) => r.id !== remove,
                  ),
                }));
                setRemove(null);
              }}
            >
              Remove requirement
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
