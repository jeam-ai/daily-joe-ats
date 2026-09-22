"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Application } from "@/types";
import { useApp } from "./provider";
import { Avatar, Button, Field, Input, Modal, Select, Badge } from "./ui";
import { requestJson } from "@/lib/client-request";
import { formalName, nameParts } from "@/lib/names";
import { canManage } from "@/lib/data-policy";

export function ApplicantEditor({
  application,
  onClose,
}: {
  application?: Application;
  onClose: () => void;
}) {
  const { state, updateApplication, refresh, notify } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [needId, setNeedId] = useState(application?.hiringNeedId || "");
  const [createdId, setCreatedId] = useState<string>();
  const parts = application
    ? nameParts(application.applicant.name)
    : { firstName: "", middleName: "", lastName: "" };
  const [requestId] = useState(() => crypto.randomUUID());
  if (!state) return null;
  const need = state.hiringNeeds.find((n) => n.id === needId);
  return (
    <Modal
      title={application ? "Edit Applicant" : "Add Applicant"}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const form = new FormData(event.currentTarget);
          const fields = {
            name: formalName(
              [
                form.get("firstName"),
                form.get("middleName"),
                form.get("lastName"),
              ]
                .filter(Boolean)
                .join(" "),
            ),
            firstName: formalName(String(form.get("firstName") || "")),
            middleName: formalName(String(form.get("middleName") || "")),
            lastName: formalName(String(form.get("lastName") || "")),
            assignedBranch: String(form.get("assignedBranch") || ""),
            appliedAt: form.get("appliedAt")
              ? new Date(String(form.get("appliedAt"))).toISOString()
              : undefined,
            email: String(form.get("email")).trim().toLowerCase(),
            phone: String(form.get("phone")).trim(),
            position: String(form.get("position")).trim(),
            location: String(form.get("location")).trim(),
            residence: String(form.get("residence") || "").trim(),
            education: String(form.get("education") || "").trim(),
            availability: String(form.get("availability") || "").trim(),
            experienceDetails: String(
              form.get("experienceDetails") || "",
            ).trim(),
            hiringNeedId: needId || undefined,
            notes: String(form.get("notes")).trim(),
          };
          try {
            if (application) {
              const saved = await updateApplication(
                application.id,
                (a) => ({
                  ...a,
                  position: fields.position,
                  location: fields.location,
                  hiringNeedId: fields.hiringNeedId,
                  assignedBranch: fields.assignedBranch,
                  appliedAt: fields.appliedAt || a.appliedAt,
                  applicant: {
                    ...a.applicant,
                    name:
                      a.isDemo && !fields.name.startsWith("DEMO — ")
                        ? `DEMO — ${fields.name}`
                        : fields.name,
                    firstName: fields.firstName,
                    middleName: fields.middleName,
                    lastName: fields.lastName,
                    email: fields.email,
                    phone: fields.phone,
                    location: fields.residence,
                    education: fields.education,
                    availability: fields.availability,
                    experienceDetails: fields.experienceDetails,
                  },
                  notes: fields.notes ? [...a.notes, fields.notes] : a.notes,
                }),
                true,
              );
              if (!saved) {
                setError(
                  "Changes were not saved. Review the notification and try again.",
                );
                return;
              }
              const photo = form.get("photo");
              const removePhoto = form.get("removePhoto") === "on";
              if (photo instanceof File && photo.size) {
                const payload = new FormData();
                payload.set("photo", photo);
                await requestJson(`/api/applicants/${application.id}/photo`, {
                  method: "POST",
                  body: payload,
                });
                await refresh();
              } else if (removePhoto && application.applicantPhotoId) {
                await requestJson(`/api/applicants/${application.id}/photo`, {
                  method: "DELETE",
                });
                await refresh();
              }
            } else {
              const result = createdId
                ? { id: createdId }
                : await requestJson<{ id: string }>("/api/applicants", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...fields, requestId }),
                  });
              setCreatedId(result.id);
              const resume = form.get("resume");
              if (resume instanceof File && resume.size) {
                const payload = new FormData();
                payload.set("resume", resume);
                try {
                  await requestJson(`/api/applicants/${result.id}/resume`, {
                    method: "POST",
                    body: payload,
                  });
                } catch (error) {
                  await refresh();
                  throw new Error(
                    `Applicant saved. Resume upload needs retry: ${(error as Error).message}`,
                  );
                }
              }
              await refresh();
              notify("Applicant created successfully.");
              router.push(`/applications/${result.id}`);
            }
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {application && (
          <p className="fine-print">
            {application.id} · {application.source || "Recruitment"}
            {application.isDemo && <Badge tone="amber">DEMO DATA</Badge>}
          </p>
        )}
        {application && (
          <div className="applicant-photo-field">
            <Avatar
              name={application.applicant.name}
              imageUrl={
                application.applicantPhotoId
                  ? `/api/applicants/${application.id}/photo?v=${encodeURIComponent(application.applicantPhotoVersion || "1")}`
                  : undefined
              }
            />
            <div>
              <Field label="Applicant photo (optional)">
                <Input name="photo" type="file" accept="image/png,image/jpeg" />
                <small>
                  PNG or JPG, up to 2 MB. Initials remain when no photo is set.
                </small>
              </Field>
              {application.applicantPhotoId && (
                <label className="checkbox-row">
                  <input name="removePhoto" type="checkbox" />
                  Remove current photo and use initials
                </label>
              )}
            </div>
          </div>
        )}
        <div className="form-grid">
          {(
            [
              ["firstName", "First name"],
              ["middleName", "Middle name / initial"],
              ["lastName", "Last name"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                name={key}
                required={key === "firstName"}
                maxLength={100}
                defaultValue={application?.applicant[key] ?? parts[key]}
                autoComplete="off"
              />
            </Field>
          ))}
          <Field label="Application date">
            <Input
              name="appliedAt"
              type="datetime-local"
              defaultValue={
                application?.appliedAt
                  ? new Date(
                      new Date(application.appliedAt).getTime() -
                        new Date(application.appliedAt).getTimezoneOffset() *
                          60000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : undefined
              }
            />
          </Field>
          <Field label="Assigned branch">
            <Select
              name="assignedBranch"
              defaultValue={application?.assignedBranch || ""}
            >
              <option value="">Unassigned</option>
              {state.locations
                ?.filter(
                  (l) => l.active || l.name === application?.assignedBranch,
                )
                .map((l) => (
                  <option key={l.id}>{l.name}</option>
                ))}
            </Select>
          </Field>
          <Field label="Email">
            <Input
              name="email"
              type="email"
              required
              maxLength={254}
              defaultValue={application?.applicant.email}
              autoComplete="off"
            />
          </Field>
          <Field label="Phone">
            <Input
              name="phone"
              type="tel"
              maxLength={60}
              defaultValue={application?.applicant.phone}
              autoComplete="off"
            />
          </Field>
          <Field label="Hiring need">
            <Select
              value={needId}
              onChange={(e) => setNeedId(e.target.value)}
              disabled={!canManage(state.currentUser)}
            >
              <option value="">Unassigned</option>
              {state.hiringNeeds
                .filter(
                  (n) =>
                    !!n.isDemo === !!application?.isDemo &&
                    (n.status === "Open" || n.id === needId),
                )
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.isDemo ? "DEMO — " : ""}
                    {n.position} — {n.location}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Applied position">
            <Input
              list="applicant-positions"
              name="position"
              required
              defaultValue={application?.position || ""}
              maxLength={200}
            />
          </Field>
          <Field label="Preferred work location">
            <Input
              name="location"
              required
              defaultValue={application?.location || ""}
              placeholder="Requires review if not stated"
              maxLength={200}
            />
          </Field>
          <Field label="Residence / address">
            <Input
              name="residence"
              defaultValue={application?.applicant.location || ""}
              maxLength={1000}
            />
          </Field>
          <Field label="Education">
            <Input
              name="education"
              defaultValue={application?.applicant.education || ""}
              maxLength={1000}
            />
          </Field>
          <Field label="Availability">
            <Input
              name="availability"
              defaultValue={application?.applicant.availability || ""}
              maxLength={1000}
            />
          </Field>
          <Field label="Experience details">
            <textarea
              name="experienceDetails"
              defaultValue={application?.applicant.experienceDetails || ""}
              maxLength={4000}
              rows={3}
            />
          </Field>
        </div>
        <datalist id="applicant-positions">
          {state.qualifications.map((q) => (
            <option key={q.id} value={q.position} />
          ))}
        </datalist>
        {!application && (
          <Field label="Upload resume (optional)">
            <Input
              name="resume"
              type="file"
              accept=".pdf,.docx,.png,.jpg,.jpeg"
            />
            <small>
              PDF, DOCX, PNG or JPG up to 8 MB. No resume is required. Submitted
              information is processed after the record is saved.
            </small>
          </Field>
        )}
        <Field label="Add an HR note">
          <textarea
            name="notes"
            maxLength={10000}
            rows={3}
            placeholder="Add context; earlier notes remain in the audit history."
          />
        </Field>
        {application && (
          <div className="info-banner">
            Stage: {application.stage} · Status: {application.status}. Use
            Proceed, Reject, Withdraw, or Talent Pool in the actions menu to
            change the workflow with confirmation.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy
              ? "Saving…"
              : application
                ? "Save changes"
                : "Create Applicant"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteApplicantDialog({
  application: a,
  onClose,
  onDeleted,
}: {
  application: Application;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { refresh, notify } = useApp();
  const [typedId, setTypedId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Delete Applicant?" onClose={onClose} busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const reason = String(
            new FormData(e.currentTarget).get("reason") || "",
          );
          try {
            const result = await requestJson<{ message: string }>(
              `/api/applicants/${a.id}`,
              {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirmed: true, typedId, reason }),
              },
            );
            await refresh();
            notify(result.message);
            onClose();
            onDeleted?.();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="confirmation-summary">
          <div>
            <strong>{a.applicant.name}</strong>
            <p>
              {a.id} · {a.position}
            </p>
          </div>
        </div>
        <p>
          {a.isDemo
            ? "This will permanently remove this demo applicant and associated recruitment data."
            : "This removes the applicant from active views and preserves their recruitment history. Only an administrator can restore it from Data Management."}
        </p>
        {!a.isDemo && (
          <>
            <Field label={`Type ${a.id} to confirm deletion`}>
              <Input
                autoComplete="off"
                value={typedId}
                onChange={(e) => setTypedId(e.target.value)}
                required
              />
            </Field>
            <Field label="Deletion reason">
              <textarea name="reason" rows={2} maxLength={2000} required />
            </Field>
          </>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            type="submit"
            disabled={busy || (!a.isDemo && typedId !== a.id)}
          >
            {busy ? "Deleting…" : "Delete Applicant"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
