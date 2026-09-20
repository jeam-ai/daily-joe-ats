"use client";
import { useEffect, useState } from "react";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { Badge, Button, Card } from "./ui";
type Status = {
  enabled: boolean;
  configured: boolean;
  jobs: { status: string; completedAt?: string; error?: string }[];
};
export function ExtractionSettings() {
  const { state } = useApp();
  const [data, setData] = useState<Status>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    requestJson<Status>("/api/system/extraction")
      .then((value) => {
        setError("");
        setData(value);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card>
      <div className="card-heading">
        <div>
          <h2>AI Integration · extraction fallback</h2>
          <p>
            Clarify missing or uncertain submitted information after normal
            extraction.
          </p>
        </div>
        <Badge>
          {!data
            ? "Checking status…"
            : data.configured
              ? data.enabled
                ? "Enabled"
                : "Disabled"
              : "Not configured"}
        </Badge>
      </div>
      <div className="padded form-stack">
        <p>
          Automatic fallback uses Gemini only for incomplete or conflicting
          evidence. It preserves HR-verified fields and never changes
          qualification results or hiring stages. Optional AI Assist remains a
          separate, manually requested interpretation.
        </p>
        {data && (
          <>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={data.enabled}
                disabled={
                  busy ||
                  !data.configured ||
                  state?.currentUser?.role !== "Admin"
                }
                onChange={async (e) => {
                  setBusy(true);
                  setError("");
                  try {
                    setData(
                      await requestJson<Status>("/api/system/extraction", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled: e.target.checked }),
                      }),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />{" "}
              Automatic extraction fallback {data.enabled ? "ON" : "OFF"}
            </label>
            <p className="fine-print">
              Application usage:{" "}
              {data.jobs.filter((j) => j.status === "Completed").length}{" "}
              completed ·{" "}
              {
                data.jobs.filter(
                  (j) => j.status === "Queued" || j.status === "Running",
                ).length
              }{" "}
              pending · {data.jobs.filter((j) => j.status === "Failed").length}{" "}
              need review. Provider quota is managed by Gemini.
            </p>
          </>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}{" "}
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
