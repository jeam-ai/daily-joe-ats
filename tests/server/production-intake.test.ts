import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord } from "../../lib/server/database";
import {
  getState,
  saveState,
  updatePreferences,
} from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";
import { withStore } from "../../lib/server/store";
import {
  AUTOMATIC_INTAKE_BATCH_SIZE,
  syncIntake,
  intakeStatus,
} from "../../lib/google/gmail/sync";
import { activeIntake } from "../../lib/data-policy";
import { matchHiringNeed, senderName } from "../../lib/intake-matching";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_SHEETS_ID;
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-production-intake-")));
test("paused intake reports its real state and never contacts Gmail even when forced", async () => {
  const state = initialState();
  state.intakePaused = true;
  await transaction((tx) => putRecord(tx, "workspace", "main", state));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Paused intake must not call providers");
  };
  try {
    assert.equal((await intakeStatus()).status, "paused");
    await syncIntake(undefined, true);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("automatic intake resumes beyond ten, maintains latest 100 with an older queue, preserves rejected history and never sends mail", async () => {
  const initial = initialState();
  initial.qualifications.push({
    id: "unassigned-test",
    position: "Barista",
    minimum: "Unassigned template must not be assessed",
    preferred: "",
    criteria: "",
    questions: "",
    rules: [
      {
        id: "sample-rule",
        label: "Customer service experience",
        kind: "Minimum",
        absenceFails: false,
      },
    ],
  });
  await transaction((tx) => putRecord(tx, "workspace", "main", initial));
  await withStore((s) => {
    s.officialConnection = {
      email: "careers@example.invalid",
      accessToken: "fixture",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 600000,
      connectedAt: new Date().toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
  });
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/send")) {
      sends++;
      throw Error("No sending permitted");
    }
    if (url.endsWith("/profile"))
      return Response.json({ emailAddress: "careers@example.invalid" });
    if (url.includes("messages?")) {
      const second = url.includes("pageToken=next");
      return Response.json({
        messages: Array.from({ length: second ? 5 : 100 }, (_, i) => ({
          id: String(i + (second ? 100 : 0)),
        })),
        nextPageToken: second ? undefined : "next",
      });
    }
    const id = url.match(/messages\/(\d+)/)?.[1];
    assert.ok(id);
    return Response.json({
      id,
      threadId: `thread-${id}`,
      internalDate: String(Date.now()),
      payload: {
        headers: [
          {
            name: "From",
            value: `DEMO Candidate ${id} <candidate${id}@example.invalid>`,
          },
          { name: "Subject", value: "Application for Barista" },
        ],
        parts: [
          {
            filename: "resume.txt",
            body: {
              data: Buffer.from(
                `Fictional QA resume ${id}. Customer service experience. Phone 0912 345 6789.`,
              ).toString("base64url"),
            },
          },
        ],
      },
    });
  };
  try {
    await Promise.all([
      syncIntake(undefined, true),
      syncIntake(undefined, true),
    ]);
    let s = await transaction(getState);
    assert.equal(
      s.applications.length,
      AUTOMATIC_INTAKE_BATCH_SIZE,
      "lease prevents concurrent duplicate batches",
    );
    assert.equal(
      Number(
        (
          await transaction((tx) =>
            tx.query("SELECT COUNT(*) AS n FROM records WHERE collection=$1", [
              "import_previews",
            ]),
          )
        )[0].n,
      ),
      0,
      "automatic intake does not persist temporary preview files",
    );
    for (let i = 1; i < 100 / AUTOMATIC_INTAKE_BATCH_SIZE; i++)
      await syncIntake(undefined, true);
    s = await transaction(getState);
    assert.equal(s.applications.filter(activeIntake).length, 100);
    assert.equal(
      s.notifications.filter((n) => n.id.startsWith("new-")).length,
      100,
    );
    assert.ok(
      s.notifications
        .filter((n) => n.id.startsWith("new-"))
        .every((n) =>
          n.description.includes(
            "Assign a hiring need to review qualifications",
          ),
        ),
    );
    assert.ok(
      s.applications.every((a) => !a.hiringNeedId && a.status === "New"),
    );
    assert.ok(s.applications.every((a) => a.screening.criteria.length === 0));
    await syncIntake(undefined, true);
    assert.equal((await intakeStatus()).status, "complete");
    s = await transaction(getState);
    assert.equal(s.applications.length, 100 + AUTOMATIC_INTAKE_BATCH_SIZE);
    assert.equal(
      s.applications.filter((a) => a.queueState === "Queued").length,
      AUTOMATIC_INTAKE_BATCH_SIZE,
    );
    s.applications[0].status = "Rejected";
    await transaction((tx) => saveState(tx, s));
    await syncIntake();
    s = await transaction(getState);
    assert.equal(s.applications.length, 100 + AUTOMATIC_INTAKE_BATCH_SIZE);
    assert.equal(s.applications.filter(activeIntake).length, 100);
    assert.equal(s.applications[0].status, "Rejected");
    assert.equal(
      new Set(s.applications.map((a) => a.gmailMessageId)).size,
      100 + AUTOMATIC_INTAKE_BATCH_SIZE,
    );
    assert.equal(sends, 0);
    assert.ok(
      (await withStore((s) => s.officialConnection, false))?.refreshToken,
    );
    const saved = await updatePreferences(
      { ...initial.preferences, theme: "dark" },
      initial.users![0],
    );
    assert.equal(saved.preferences.theme, "dark");
    assert.equal(
      saved.applicationSummary?.real.total,
      100 + AUTOMATIC_INTAKE_BATCH_SIZE,
      "a preference save preserves every server-side applicant beyond the bounded preview",
    );
    assert.ok(
      (await transaction(getState)).applications.some(
        (application) => application.status === "Rejected",
      ),
      "the server-side applicant omitted from the workspace preview remains intact",
    );
    await assert.rejects(
      updatePreferences(
        saved.preferences,
        { ...initial.users![0], role: "Viewer" },
        "has:attachment",
      ),
    );
    await assert.rejects(
      updatePreferences(
        saved.preferences,
        initial.users![0],
        "has:attachment",
        "demo",
      ),
    );
    await assert.rejects(
      updatePreferences(
        { ...saved.preferences, theme: "invalid" },
        initial.users![0],
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("matching needs evidence of both position and location; sender addresses are never fabricated names", () => {
  assert.equal(
    senderName("unknown@example.invalid"),
    "Applicant name was not clearly stated in the submitted application.",
  );
  const need = {
    id: "n",
    position: "Barista",
    location: "Naga City",
    status: "Open",
    criteria: [],
  } as never;
  assert.equal(matchHiringNeed("Barista", [need]), undefined);
  assert.equal(
    matchHiringNeed("Application Barista — Naga City", [need])?.id,
    "n",
  );
  assert.equal(
    matchHiringNeed("Application Barista — Naga City", [need, need]),
    undefined,
  );
});
test("unreadable attachments preserve email facts and do not pause intake", async () => {
  const state = await transaction(getState);
  await transaction((tx) =>
    putRecord(tx, "jobs", "gmail", {
      status: "checking",
      message: "Prior attachment failure",
      // Simulate a host that ended a run after it had acquired its lease. The
      // next worker must reclaim this safely instead of holding the UI on a
      // stale "Checking" message until the original lease time elapses.
      startedAt: new Date(Date.now() - 91000).toISOString(),
      leaseUntil: Date.now() + 60000,
      pending: ["broken"],
      issues: [
        {
          message: "Old attachment message",
          reason: "Failed to read resume from a previous attempt.",
        },
      ],
      imported: 0,
      checked: 0,
      failures: 2,
      consecutiveFailures: 2,
      retryAt: 0,
      headCheckedAt: Date.now(),
      query: state.intakeQuery,
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/profile"))
      return Response.json({ emailAddress: "careers@example.invalid" });
    assert.ok(url.includes("messages/broken"));
    return Response.json({
      id: "broken",
      threadId: "broken-thread",
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: "From", value: "Fictional Broken <broken@example.invalid>" },
          { name: "Subject", value: "Application with damaged DOCX" },
        ],
        parts: [
          {
            filename: "resume.docx",
            body: {
              data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString(
                "base64url",
              ),
            },
          },
        ],
      },
    });
  };
  try {
    await syncIntake();
    const job = await intakeStatus();
    assert.equal(job.status, "complete");
    assert.equal(job.consecutiveFailures, 0);
    assert.equal(job.pending.length, 0);
    assert.equal(job.imported, 1);
    assert.equal(
      job.issues.length,
      0,
      "a successful email-only fallback clears an old resolved review item",
    );
    assert.doesNotMatch(job.message, /unreadable attachments/i);
    assert.ok(job.seenIds?.includes("broken"));
    const imported = (await transaction(getState)).applications.find(
      (application) => application.gmailMessageId === "broken",
    );
    assert.ok(imported);
    assert.ok(
      imported?.resumeId,
      "a type-validated document is retained for HR retry even if extraction fails",
    );
    assert.match(imported?.notes.join(" ") || "", /processing was deferred/i);
  } finally {
    globalThis.fetch = original;
  }
});

test("expired job leases become an actionable retry state", async () => {
  await transaction((tx) =>
    putRecord(tx, "jobs", "gmail", {
      status: "processing",
      message: "old",
      leaseUntil: Date.now() - 1,
      runId: "stale",
      pending: [],
      issues: [],
      imported: 0,
      checked: 0,
    }),
  );
  assert.equal((await intakeStatus()).status, "error");
});
test("an aged Gmail worker becomes actionable even before its stale lease expires", async () => {
  await transaction((tx) =>
    putRecord(tx, "jobs", "gmail", {
      status: "checking",
      message: "Checking the official mailbox…",
      startedAt: new Date(Date.now() - 91000).toISOString(),
      leaseUntil: Date.now() + 60000,
      runId: "aged-worker",
      pending: ["saved-message"],
      issues: [],
      imported: 0,
      checked: 0,
    }),
  );
  const job = await intakeStatus();
  assert.equal(job.status, "error");
  assert.match(job.message, /stopped before completion/i);
});
