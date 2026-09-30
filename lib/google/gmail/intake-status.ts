import "server-only";
import { readTransaction, readRecord } from "@/lib/server/database";
import type { IntakeSync } from "./sync";

const STALE_INTAKE_WORKER_MS = 90000;

const empty = (): IntakeSync => ({
  status: "idle",
  message: "Ready to check the careers mailbox.",
  imported: 0,
  checked: 0,
  pending: [],
  issues: [],
});

/**
 * Lightweight, database-only Gmail intake status for visible HR tabs.
 *
 * Keep this module separate from the Gmail import worker: importing the full
 * worker also brings document parsing/OCR into a status-only server function.
 */
export async function intakeStatus() {
  return readTransaction(async (tx) => {
    const state =
      (await readRecord<IntakeSync>(tx, "jobs", "gmail")) || empty();
    const workspace = await readRecord<{ intakePaused?: boolean }>(
      tx,
      "workspace",
      "main",
    );
    if (workspace?.intakePaused)
      return {
        ...state,
        status: "paused" as const,
        message:
          "Gmail intake is paused. Resume it in Settings when you are ready.",
      };
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0;
    const stalled =
      ["checking", "processing"].includes(state.status) &&
      ((state.leaseUntil && state.leaseUntil < Date.now()) ||
        !startedAt ||
        Date.now() - startedAt > STALE_INTAKE_WORKER_MS);
    if (stalled) {
      state.status = "error";
      state.message =
        "The last Gmail check stopped before completion. Retrying safely from the saved queue…";
      delete state.runId;
      delete state.leaseUntil;
    }
    state.issues = state.issues.filter(
      (issue) =>
        !(
          issue.message === "Import preview" &&
          /Preview time limit reached/i.test(issue.reason)
        ),
    );
    return state;
  });
}
