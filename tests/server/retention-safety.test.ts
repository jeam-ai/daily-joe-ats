import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application } from "../../types";
import { readTransaction, transaction } from "../../lib/server/database";
import { getState, saveState } from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";
import { runRetentionCleanup } from "../../lib/server/retention";

delete process.env.DATABASE_URL;
delete process.env.VERCEL;
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  DRY_RUN_RETENTION_CLEANUP: "true",
  RETENTION_CLEANUP_VERIFIED: "false",
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-retention-")));

function application(id: string, appliedAt: string): Application {
  return {
    id,
    applicant: {
      id: `person-${id}`,
      name: `Test Applicant ${id}`,
      email: `${id}@example.invalid`,
      phone: "",
      location: "",
      experience: 0,
    },
    position: "Test Position",
    location: "Test Location",
    appliedAt,
    stage: "Screening",
    status: "New",
    screening: {
      outcome: "Requires Review",
      criteria: [],
      completedAt: appliedAt,
    },
    lastActivity: appliedAt,
    notes: [],
    interviews: [],
    requirements: [],
    timeline: [],
    onboardingStatus: "Pending Orientation",
  };
}

test("Talent Pool expiry runs once and removes only the membership", async () => {
  const state = initialState();
  const pooled = application("pooled", "2026-01-01T00:00:00.000Z");
  pooled.status = "Talent Pool";
  pooled.talentPoolAddedAt = "2026-01-01T00:00:00.000Z";
  state.applications.push(pooled);
  await transaction((tx) => saveState(tx, state, { sync: false }));
  const countMemberships = () =>
    readTransaction(async (tx) =>
      Number(
        (await tx.query("SELECT COUNT(*) AS n FROM talent_pool_memberships"))[0]
          .n,
      ),
    );
  assert.equal(await countMemberships(), 1);
  const preview = await runRetentionCleanup();
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wouldExpireTalentPool, 1);
  assert.equal(await countMemberships(), 1);
  const attemptedOverride = await runRetentionCleanup({ dryRun: false });
  assert.equal(attemptedOverride.dryRun, true);
  assert.equal(await countMemberships(), 1);
  process.env.DRY_RUN_RETENTION_CLEANUP = "false";
  process.env.RETENTION_CLEANUP_VERIFIED = "true";
  let applied;
  try {
    applied = await runRetentionCleanup({ dryRun: false });
  } finally {
    process.env.DRY_RUN_RETENTION_CLEANUP = "true";
    process.env.RETENTION_CLEANUP_VERIFIED = "false";
  }
  assert.equal(applied.deletedTalentPoolMemberships, 1);
  assert.equal(await countMemberships(), 0);
  const next = await runRetentionCleanup({ dryRun: false });
  assert.equal(next.wouldExpireTalentPool, 0);
  const persisted = await readTransaction((tx) => getState(tx));
  assert.ok(persisted.applications[0].talentPoolExpiredAt);
  assert.equal(persisted.applications[0].status, "Talent Pool");
});

test("Requirements are protected outside 500 and return to the queue cancels grace", async () => {
  const state = initialState();
  const older = application("older", "2026-01-01T00:00:00.000Z");
  const protectedNeed = application("requirements", "2026-01-02T00:00:00.000Z");
  protectedNeed.stage = "Requirements";
  protectedNeed.status = "In Progress";
  const protectedStages = [
    protectedNeed,
    ...(["Initial Interview", "Final Interview", "Onboarding"] as const).map(
      (stage, index) => {
        const selected = application(
          `protected-${index}`,
          `2026-01-0${index + 3}T00:00:00.000Z`,
        );
        selected.stage = stage;
        selected.status = "In Progress";
        return selected;
      },
    ),
  ];
  const hired = application("hired", "2026-01-06T00:00:00.000Z");
  hired.stage = "Hired";
  hired.status = "Hired";
  state.applications.push(older, ...protectedStages, hired);
  for (let i = 0; i < 500; i++)
    state.applications.push(
      application(
        `new-${i}`,
        `2026-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );
  await transaction((tx) => saveState(tx, state, { sync: false }));
  await runRetentionCleanup();
  const retention = () =>
    readTransaction((tx) =>
      tx.query("SELECT application_id FROM application_retention"),
    );
  assert.deepEqual(
    (await retention()).map((r) => String(r.application_id)),
    ["older"],
  );
  const replyAt = new Date(Date.now() + 60000).toISOString();
  await transaction((tx) =>
    tx.query(
      "INSERT INTO gmail_thread_events(message_id,application_id,thread_id,occurred_at,direction,subject) VALUES($1,$2,$3,$4,$5,$6)",
      [
        "old-applicant-reply",
        "older",
        "thread-older",
        replyAt,
        "incoming",
        "Follow-up",
      ],
    ),
  );
  await runRetentionCleanup();
  const replyGrace = await readTransaction((tx) =>
    tx.query(
      "SELECT started_at FROM application_retention WHERE application_id=$1",
      ["older"],
    ),
  );
  assert.equal(replyGrace[0].started_at, replyAt);
  await transaction(async (tx) => {
    const current = await getState(tx);
    for (const id of ["new-0", "new-1", "new-2", "new-3", "new-4"]) {
      const selected = current.applications.find((a) => a.id === id)!;
      selected.status = "Hired";
      selected.stage = "Hired";
    }
    await saveState(tx, current, { sync: false });
  });
  await runRetentionCleanup();
  assert.deepEqual(await retention(), []);
});
