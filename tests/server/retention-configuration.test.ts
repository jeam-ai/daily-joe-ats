import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application, HiringNeed } from "../../types";
import { readTransaction, transaction } from "../../lib/server/database";
import { getState, publicState, saveState } from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";
import {
  readRetentionPolicies,
  runRetentionCleanup,
} from "../../lib/server/retention";

for (const name of [
  "AIVEN_DATABASE_URL",
  "DATABASE_POOL_URL",
  "DATABASE_URL",
  "VERCEL",
  "PERSISTENCE_PROVIDER",
])
  delete process.env[name];
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
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-retention-config-")));

const day = 86400000;
const iso = (time: number) => new Date(time).toISOString();
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

test("configured retention dates drive Talent Pool, terminal, Hiring Need, activity, and warnings without deleting in QA", async () => {
  const now = Date.now();
  const poolStart = iso(now - 15 * day);
  const rejectedAt = iso(now - 5 * day);
  const target = iso(now - 5 * day).slice(0, 10);
  const state = initialState();
  const pooled = application("pool-policy", poolStart);
  pooled.status = "Talent Pool";
  pooled.talentPoolAddedAt = poolStart;
  const rejected = application("rejected-policy", rejectedAt);
  rejected.status = "Rejected";
  const need: HiringNeed = {
    id: "need-policy",
    position: "Test Position",
    location: "Test Location",
    slots: 1,
    filled: 0,
    urgency: "Medium",
    targetDate: target,
    status: "Open",
    qualifications: "",
    questions: "",
  };
  state.applications.push(pooled, rejected);
  state.hiringNeeds.push(need);
  await transaction(async (tx) => {
    await saveState(tx, state, { sync: false });
    for (const [name, days] of Object.entries({
      terminal_application_days: 12,
      talent_pool_days: 20,
      talent_pool_grace_days: 6,
      hiring_need_days: 15,
      activity_log_days: 45,
    }))
      await tx.query(
        "INSERT INTO retention_policies(name,days,updated_at) VALUES($1,$2,$3)",
        [name, days, iso(now)],
      );
    await tx.query(
      "INSERT INTO audit_logs(id,occurred_at,actor,action,payload) VALUES($1,$2,$3,$4,$5)",
      ["old-event", iso(now - 40 * day), "System", "test", "{}"],
    );
  });
  const preview = await runRetentionCleanup();
  assert.equal(preview.dryRun, true);
  assert.equal(preview.deletedApplications, 0);
  assert.equal(preview.deletedHiringNeeds, 0);
  assert.equal(preview.wouldCleanActivityLogs, 0);
  const saved = await readTransaction(async (tx) => ({
    policy: await readRetentionPolicies(tx),
    retention: await tx.query(
      "SELECT application_id,category,expires_at FROM application_retention ORDER BY application_id",
    ),
    membership: await tx.query(
      "SELECT expires_at,grace_expires_at FROM talent_pool_memberships WHERE applicant_id=$1",
      [pooled.applicant.id],
    ),
    need: await tx.query(
      "SELECT expires_at FROM hiring_need_retention WHERE hiring_need_id=$1",
      [need.id],
    ),
  }));
  assert.equal(saved.policy.terminal_application_days, 12);
  assert.equal(saved.policy.activity_log_days, 45);
  assert.equal(saved.retention.length, 2);
  assert.equal(
    saved.retention.find((row) => row.application_id === rejected.id)
      ?.expires_at,
    iso(Date.parse(rejectedAt) + 12 * day),
  );
  assert.equal(
    saved.membership[0].expires_at,
    iso(Date.parse(poolStart) + 20 * day),
  );
  assert.equal(
    saved.membership[0].grace_expires_at,
    iso(Date.parse(poolStart) + 26 * day),
  );
  assert.equal(saved.need[0].expires_at, iso(Date.parse(target) + 15 * day));

  const visible = await publicState(state.users![0]);
  const visiblePool = visible.applications.find(
    (item) => item.id === pooled.id,
  );
  assert.equal(
    visiblePool?.talentPoolExpiresAt,
    saved.membership[0].expires_at,
  );
  assert.equal(
    visiblePool?.talentPoolGraceExpiresAt,
    saved.membership[0].grace_expires_at,
  );
  assert.equal(
    visible.hiringNeeds.find((item) => item.id === need.id)?.retentionExpiresAt,
    saved.need[0].expires_at,
  );
  assert.ok(
    visible.notifications.some(
      (item) =>
        item.id === `talent-retention-${pooled.id}` &&
        item.title === "Talent Pool expiry approaching",
    ),
  );

  await transaction((tx) =>
    tx.query("UPDATE retention_policies SET days=$1 WHERE name=$2", [
      3,
      "terminal_application_days",
    ]),
  );
  const shortened = await runRetentionCleanup();
  assert.equal(shortened.dryRun, true);
  assert.equal(shortened.wouldDeleteApplications, 1);
  assert.ok(
    (await readTransaction((tx) => getState(tx))).applications.some(
      (item) => item.id === rejected.id,
    ),
  );

  const laterTarget = iso(now - 2 * day).slice(0, 10);
  await transaction(async (tx) => {
    const current = await getState(tx);
    current.hiringNeeds[0].targetDate = laterTarget;
    await saveState(tx, current, { sync: false });
  });
  await runRetentionCleanup();
  const revised = await readTransaction((tx) =>
    tx.query(
      "SELECT expires_at FROM hiring_need_retention WHERE hiring_need_id=$1",
      [need.id],
    ),
  );
  assert.equal(revised[0].expires_at, iso(Date.parse(laterTarget) + 15 * day));
  assert.notEqual(revised[0].expires_at, saved.need[0].expires_at);

  await transaction(async (tx) => {
    const current = await getState(tx);
    current.hiringNeeds[0].targetDate = iso(now + 30 * day).slice(0, 10);
    current.applications.find((item) => item.id === rejected.id)!.status =
      "In Progress";
    await saveState(tx, current, { sync: false });
  });
  await runRetentionCleanup();
  const cancelled = await readTransaction(async (tx) => ({
    needs: await tx.query(
      "SELECT hiring_need_id FROM hiring_need_retention WHERE hiring_need_id=$1",
      [need.id],
    ),
    terminal: await tx.query(
      "SELECT application_id FROM application_retention WHERE application_id=$1",
      [rejected.id],
    ),
  }));
  assert.equal(cancelled.needs.length, 0);
  assert.equal(cancelled.terminal.length, 0);
});
