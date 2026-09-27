import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application } from "../../types";
import { transaction, type Transaction } from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import { saveState } from "../../lib/server/repository";

for (const name of [
  "AIVEN_DATABASE_URL",
  "DATABASE_POOL_URL",
  "DATABASE_URL",
  "VERCEL",
  "PERSISTENCE_PROVIDER",
])
  delete process.env[name];
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-shared-applicant-upsert-")));

test("two applications for one applicant produce one PostgreSQL-safe applicant upsert", async () => {
  const state = initialState();
  const first: Application = {
    id: "application-one",
    applicant: {
      id: "person-one",
      name: "Earlier Submitted Name",
      email: "returning@example.invalid",
      phone: "",
      location: "",
      experience: 0,
    },
    position: "Barista",
    location: "Branch One",
    appliedAt: "2026-09-01T00:00:00.000Z",
    stage: "Screening",
    status: "New",
    screening: { outcome: "Requires Review", criteria: [], completedAt: "" },
    lastActivity: "2026-09-01T00:00:00.000Z",
    notes: [],
    interviews: [],
    requirements: [],
    timeline: [],
    gmailMessageId: "gmail-one",
    onboardingStatus: "Pending Orientation",
  };
  const second: Application = {
    ...first,
    id: "application-two",
    applicant: { ...first.applicant, name: "Later Submitted Name" },
    appliedAt: "2026-09-02T00:00:00.000Z",
    lastActivity: "2026-09-02T00:00:00.000Z",
    gmailMessageId: "gmail-two",
  };
  state.applications.push(first, second);

  let applicantUpserts = 0;
  await transaction(async (tx) => {
    const checkedTx: Transaction = {
      query: async (sql, values = []) => {
        if (sql.startsWith("INSERT INTO applicants(")) {
          applicantUpserts++;
          const ids = values.filter((_, index) => index % 3 === 0);
          assert.equal(new Set(ids).size, ids.length);
          assert.equal(ids.length, 1);
        }
        return tx.query(sql, values);
      },
    };
    await saveState(checkedTx, state);
  });
  assert.equal(applicantUpserts, 1);
  await transaction(async (tx) => {
    const people = await tx.query("SELECT id,payload FROM applicants");
    const applications = await tx.query("SELECT id FROM applications");
    assert.equal(people.length, 1);
    assert.equal(applications.length, 2);
    assert.equal(
      JSON.parse(String(people[0].payload)).name,
      "Later Submitted Name",
    );
  });
});
