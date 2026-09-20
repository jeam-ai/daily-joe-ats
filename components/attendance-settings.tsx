"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AttendanceRulesEditor } from "./timekeeping";
import { defaultOdooRules, type OdooRules } from "@/lib/odoo";
import { requestJson } from "@/lib/client-request";
import { Card, Button } from "./ui";
import { useApp } from "./provider";
export function AttendanceSettings() {
  const { notify } = useApp(),
    [rules, setRules] = useState(defaultOdooRules),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    requestJson<{ template: { rules: OdooRules } | null }>("/api/timekeeping")
      .then((r) => {
        if (r.template) setRules(r.template.rules);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);
  return (
    <Card className="padded form-stack">
      <h2>Attendance rules</h2>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <AttendanceRulesEditor rules={rules} onChange={setRules} />
      <div className="button-row">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await requestJson("/api/timekeeping", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "rules", rules }),
              });
              setError("");
              notify("Attendance rules saved.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Loading…" : "Save attendance rules"}
        </Button>
        <Link className="button secondary" href="/timekeeping">
          Open combined Odoo analysis
        </Link>
      </div>
    </Card>
  );
}
