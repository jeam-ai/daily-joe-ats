"use client";
import { templateVariables, renderEmail } from "@/lib/email-templates";
import { ExtractionSettings } from "./extraction-settings";
import {
  SystemHealth,
  Diagnostics,
  AuditHistory,
  AiIntegration,
} from "./operations";
import { AttendanceSettings } from "./attendance-settings";
import Link from "next/link";
import { canManage } from "@/lib/data-policy";
import { SystemSettings } from "./system-settings";
import { SectionBoundary } from "./section-boundary";
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
import { SheetsSettings } from "./sheets-settings";
import {
  UsersSettings,
  LocationsSettings,
  QualificationsSettings,
  PreferencesSettings,
} from "./soft-settings";
const sections = [
  ["account", "Profile & Role", UserRound],
  ["users", "Authorized Users", UsersRound],

  ["qualifications", "Job & Qualification Templates", ClipboardList],
  ["requirements", "Pre-employment Requirements", FileCheck2],
  ["email-templates", "Email Templates", Mail],
  ["locations", "Locations", ClipboardList],

  ["integrations", "Gmail & Spreadsheet", Plug],
  ["ai", "AI Assist", Plug],
  ["data", "Migration, Backup & Google Sheets", SlidersHorizontal],
  ["timekeeping", "Attendance & Odoo Mapping", ClipboardList],
  ["preferences", "Appearance & Preferences", SlidersHorizontal],
  ["health", "System Health", SlidersHorizontal],
  ["diagnostics", "Error Center", SlidersHorizontal],
  ["audit", "Activity History", ClipboardList],
  ["system", "Demo & Data Management", SlidersHorizontal],
] as const;
export function Settings({ section = "integrations" }: { section?: string }) {
  const { state, update, saving, dataset } = useApp();
  const [selected, setSelected] = useState("");
  const [templatePreview, setTemplatePreview] = useState<ReturnType<
    typeof renderEmail
  > | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  if (!state) return <LoadingSkeleton />;
  const admin = state.currentUser?.role === "Admin";
  const demoReadOnly =
    dataset === "demo" &&
    [
      "users",
      "qualifications",
      "requirements",
      "email-templates",
      "locations",
    ].includes(section);
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
            <div key={slug}>
              {(
                {
                  account: "Account",
                  qualifications: "Recruitment",
                  integrations: "Integrations",
                  timekeeping: "Timekeeping",
                  preferences: "Appearance",
                  health: "System",
                } as Record<string, string>
              )[slug] && (
                <p className="settings-group-label">
                  {
                    (
                      {
                        account: "Account",
                        qualifications: "Recruitment",
                        integrations: "Integrations",
                        timekeeping: "Timekeeping",
                        preferences: "Appearance",
                        health: "System",
                      } as Record<string, string>
                    )[slug]
                  }
                </p>
              )}
              <Link
                href={`/settings/${slug}`}
                aria-current={section === slug ? "page" : undefined}
                className={section === slug ? "active" : ""}
              >
                <Icon size={17} />
                {label}
              </Link>
            </div>
          ))}
        </nav>
        <div className="settings-content">
          {demoReadOnly && (
            <p className="info-banner">
              These settings apply to real recruitment. Exit Demo to edit them.
            </p>
          )}
          <fieldset className="settings-section-fields" disabled={demoReadOnly}>
            {section === "health" && <SystemHealth />}
            {section === "data" && <SheetsSettings />}
            {section === "diagnostics" && <Diagnostics />}
            {section === "audit" && <AuditHistory />}
            {section === "ai" && (
              <>
                <ExtractionSettings />
                <AiIntegration />
              </>
            )}
            {section === "integrations" && (
              <SectionBoundary name="Integrations">
                <GmailSettings />
              </SectionBoundary>
            )}
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
                <fieldset
                  disabled={!admin || saving}
                  className="padded form-stack"
                >
                  {!admin && (
                    <p className="muted">
                      Only an administrator can change requirement templates.
                    </p>
                  )}
                  {state.requirementTemplates.map((r) => (
                    <div className="requirement-template" key={r.id}>
                      <Input
                        aria-label="Requirement name"
                        defaultValue={r.name}
                        key={r.id + r.name}
                        onBlur={(e) =>
                          e.target.value.trim() &&
                          e.target.value !== r.name &&
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
                    Changes save to the recruitment workspace. Existing
                    applicant checklists keep their historical requirements.
                  </p>
                </fieldset>
              </Card>
            )}
            {section === "email-templates" && (
              <Card>
                <div className="card-heading">
                  <div>
                    <h2>Email Templates</h2>
                    <p>Make each next step clear and personal.</p>
                  </div>
                  <Badge>Preview before sending</Badge>
                </div>
                <div className="padded">
                  <p className="fine-print">
                    Workflow:{" "}
                    {template.stage ||
                      ([
                        "Initial Interview",
                        "Final Interview",
                        "Requirements",
                        "Onboarding",
                        "Hired",
                      ].includes(template.name)
                        ? template.name
                        : "Manual communication")}{" "}
                    · Proceed queues the configured stage email after HR
                    confirmation.
                  </p>
                  <Field label="Template">
                    <Select
                      value={template.id}
                      onChange={(e) => {
                        setSelected(e.target.value);
                        setTemplatePreview(null);
                      }}
                    >
                      {state.emailTemplates.map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {!canManage(state.currentUser) && (
                    <p className="muted">
                      A recruitment manager can edit email templates.
                    </p>
                  )}
                  <fieldset disabled={!canManage(state.currentUser) || saving}>
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
                        {templateVariables.map((v) => (
                          <code key={v}>{`{{${v}}}`}</code>
                        ))}
                      </div>
                      <div className="button-row">
                        <Button type="submit">
                          <Save size={16} />
                          Save template
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={(e) => {
                            const form = e.currentTarget.form;
                            if (!form) return;
                            const d = new FormData(form);
                            setTemplatePreview(
                              renderEmail(
                                {
                                  subject: String(d.get("subject")),
                                  body: String(d.get("body")),
                                },
                                {
                                  applicant_name: "DEMO — Alex Example",
                                  first_name: "Alex",
                                  position: "Barista",
                                  location: "Naga City",
                                  application_id: "DEMO-PREVIEW",
                                  interview_date: "October 1, 2026",
                                  interview_time: "2:00 PM",
                                  hiring_need: "Barista — Naga City",
                                  company_name: "Daily Joe Careers",
                                  hr_name: "Example HR",
                                  next_step: template.stage || template.name,
                                  application_date: "September 20, 2026",
                                },
                              ),
                            );
                          }}
                        >
                          Preview with demo values
                        </Button>
                      </div>
                      {templatePreview && (
                        <div className="email-preview">
                          <Badge>DEMO PREVIEW · No email sent</Badge>
                          <h3>{templatePreview.subject}</h3>
                          <pre>{templatePreview.body}</pre>
                          {templatePreview.missing.length > 0 && (
                            <p className="error-banner">
                              Missing values:{" "}
                              {templatePreview.missing.join(", ")}
                            </p>
                          )}
                        </div>
                      )}
                    </form>
                  </fieldset>
                </div>
              </Card>
            )}
            {section === "users" && <UsersSettings />}
            {section === "preferences" && <PreferencesSettings />}
            {section === "locations" && <LocationsSettings />}
            {section === "system" && <SystemSettings />}
            {section === "timekeeping" && <AttendanceSettings />}
            {!sections.some(([slug]) => slug === section) && (
              <Card className="padded">
                <h2>Settings section not found</h2>
                <Link href="/settings/integrations">Open integrations</Link>
              </Card>
            )}
          </fieldset>
        </div>
      </div>
      {remove && (
        <Modal
          busy={saving}
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
              disabled={saving}
              onClick={async () => {
                const saved = await update((s) => ({
                  ...s,
                  requirementTemplates: s.requirementTemplates.filter(
                    (r) => r.id !== remove,
                  ),
                }));
                if (saved) setRemove(null);
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
