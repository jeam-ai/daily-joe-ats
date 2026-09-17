"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, MapPin, CalendarDays, Pencil, UsersRound } from "lucide-react";
import type { HiringNeed } from "@/types";
import { useApp } from "./provider";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Modal,
  ProgressBar,
  StatusBadge,
  LoadingSkeleton,
  EmptyState,
} from "./ui";
import Link from "next/link";
import { QualificationEditor } from "./qualification-editor";
import type { QualificationRule } from "@/types";
import { isActive } from "@/lib/recruitment";
export function HiringNeeds() {
  const { state, update, notify } = useApp();
  const params = useSearchParams();
  const [editing, setEditing] = useState<string | null>(
    params.get("new") ? "new" : params.get("edit"),
  );
  const [rules, setRules] = useState<QualificationRule[] | null>(null);
  const [filter, setFilter] = useState("Open");
  if (!state) return <LoadingSkeleton />;
  const existing = state.hiringNeeds.find((n) => n.id === editing);
  const rows = state.hiringNeeds.filter(
    (n) => filter === "All" || n.status === filter,
  );
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const need: HiringNeed = {
      id: existing?.id || crypto.randomUUID(),
      position: String(data.get("position")),
      location: String(data.get("location")),
      slots: Number(data.get("slots")),
      filled: existing?.filled || 0,
      urgency: data.get("urgency") as HiringNeed["urgency"],
      targetDate: String(data.get("date")),
      status: data.get("status") as HiringNeed["status"],
      qualifications: "",
      criteria: rules || existing?.criteria || [],
      questions: String(data.get("questions")),
    };
    if (need.slots < need.filled) {
      notify("Requested slots cannot be fewer than filled slots.");
      return;
    }
    const saved = await update((s) => ({
      ...s,
      hiringNeeds: existing
        ? s.hiringNeeds.map((n) => (n.id === need.id ? need : n))
        : [...s.hiringNeeds, need],
    }));
    if (saved) {
      setEditing(null);
      setRules(null);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE ROOM FOR GREAT PEOPLE</div>
          <h1>Hiring Needs</h1>
          <p>The right people. The right place. The right time.</p>
        </div>
        <Button
          onClick={() => {
            setRules([]);
            setEditing("new");
          }}
        >
          <Plus size={17} />
          New Hiring Need
        </Button>
      </div>
      <div className="section-heading">
        <h2>{rows.length} hiring requests</h2>
        <Select
          aria-label="Hiring need status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {["Open", "Paused", "Filled", "Closed", "All"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      </div>
      <div className="needs-grid">
        {rows.map((n) => (
          <Card key={n.id} className="need-card">
            <div className="section-heading">
              <span className="job-icon">
                <UsersRound size={24} />
              </span>
              <StatusBadge status={`${n.urgency} priority`} />
            </div>
            <h2>{n.position}</h2>
            <p className="location-line">
              <MapPin size={15} />
              {n.location}
            </p>
            <div className="need-numbers">
              <div>
                <strong>{n.slots - n.filled}</strong>
                <span>open slots</span>
              </div>
              <div>
                <strong>
                  {
                    state.applications.filter(
                      (a) => a.hiringNeedId === n.id && isActive(a),
                    ).length
                  }
                </strong>
                <span>in pipeline</span>
              </div>
              <div>
                <strong>{n.filled}</strong>
                <span>filled</span>
              </div>
            </div>
            <div className="section-heading muted">
              <span>Hiring progress</span>
              <span>
                {n.filled} of {n.slots}
              </span>
            </div>
            <ProgressBar value={(n.filled / n.slots) * 100} />
            <p className="location-line">
              <CalendarDays size={15} />
              Target:{" "}
              {new Date(n.targetDate + "T12:00:00").toLocaleDateString()}
            </p>
            <ul>
              {n.criteria?.map((r) => (
                <li key={r.id}>
                  {r.label} · {r.kind}
                </li>
              ))}
            </ul>
            <Link className="text-link" href={`/applications?need=${n.id}`}>
              View associated applicants →
            </Link>
            <div className="section-heading">
              <Badge>{n.status}</Badge>
              <Button
                variant="secondary"
                onClick={() => {
                  setRules(n.criteria || []);
                  setEditing(n.id);
                }}
              >
                <Pencil size={14} />
                Edit request
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {!rows.length && (
        <EmptyState
          title="No hiring needs"
          description="Create a request when your team is ready to grow."
        />
      )}
      {editing && (
        <Modal
          title={existing ? "Edit hiring need" : "New hiring need"}
          onClose={() => setEditing(null)}
        >
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid">
              <Field label="Position">
                <Input
                  name="position"
                  required
                  defaultValue={existing?.position}
                  list="positions"
                />
                <datalist id="positions">
                  {state.qualifications.map((q) => (
                    <option key={q.id}>{q.position}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Location">
                <Select
                  name="location"
                  required
                  defaultValue={existing?.location || ""}
                >
                  <option value="">Select a location</option>
                  {state.locations
                    ?.filter((l) => l.active || l.name === existing?.location)
                    .map((l) => (
                      <option key={l.id}>{l.name}</option>
                    ))}
                </Select>
              </Field>
              <Field label="Slots">
                <Input
                  name="slots"
                  type="number"
                  min={Math.max(1, existing?.filled || 0)}
                  required
                  defaultValue={existing?.slots || 1}
                />
              </Field>
              <Field label="Urgency">
                <Select
                  name="urgency"
                  defaultValue={existing?.urgency || "Medium"}
                >
                  {["Urgent", "High", "Medium", "Low"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Target hiring date">
                <Input
                  type="date"
                  name="date"
                  required
                  defaultValue={existing?.targetDate}
                />
              </Field>
              <Field label="Status">
                <Select name="status" defaultValue={existing?.status || "Open"}>
                  {["Open", "Paused", "Filled", "Closed"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Start with a qualification template">
              <Select
                onChange={(e) =>
                  setRules(
                    state.qualifications.find((q) => q.id === e.target.value)
                      ?.rules || [],
                  )
                }
                defaultValue=""
              >
                <option value="">Choose template (optional)</option>
                {state.qualifications.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.position}
                  </option>
                ))}
              </Select>
            </Field>
            <QualificationEditor
              value={rules || existing?.criteria || []}
              onChange={setRules}
            />
            <Field label="Interview reference questions">
              <textarea name="questions" defaultValue={existing?.questions} />
            </Field>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit">Save hiring need</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
