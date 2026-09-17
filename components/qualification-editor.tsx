"use client";
import type { QualificationRule } from "@/types";
import { Button, Field, Input, Select } from "./ui";
export function QualificationEditor({
  value,
  onChange,
}: {
  value: QualificationRule[];
  onChange: (value: QualificationRule[]) => void;
}) {
  const set = (id: string, change: Partial<QualificationRule>) =>
    onChange(value.map((r) => (r.id === id ? { ...r, ...change } : r)));
  function move(i: number, delta: number) {
    const copy = [...value];
    [copy[i], copy[i + delta]] = [copy[i + delta], copy[i]];
    onChange(copy);
  }
  return (
    <div className="form-stack">
      <h3>Qualification checklist</h3>
      <p>
        HR defines the criteria. Missing evidence stays unclear unless the
        requirement explicitly says otherwise.
      </p>
      {value.map((r, i) => (
        <div key={r.id} className="rule-editor">
          <Field label={`Requirement ${i + 1}`}>
            <Input
              value={r.label}
              required
              onChange={(e) => set(r.id, { label: e.target.value })}
            />
          </Field>
          <Field label="Requirement type">
            <Select
              value={r.kind}
              onChange={(e) =>
                set(r.id, { kind: e.target.value as QualificationRule["kind"] })
              }
            >
              <option>Minimum</option>
              <option>Preferred</option>
            </Select>
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={r.absenceFails}
              onChange={(e) => set(r.id, { absenceFails: e.target.checked })}
            />
            HR policy: absence of evidence fails this requirement
          </label>
          <div className="inline-actions">
            <Button
              type="button"
              variant="ghost"
              aria-label="Move requirement up"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Move requirement down"
              disabled={i === value.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(value.filter((v) => v.id !== r.id))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          onChange([
            ...value,
            {
              id: crypto.randomUUID(),
              label: "",
              kind: "Minimum",
              absenceFails: false,
            },
          ])
        }
      >
        + Add requirement
      </Button>
    </div>
  );
}
