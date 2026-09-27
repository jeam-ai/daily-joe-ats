import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application, User } from "../../types";
import { seal, unseal } from "../../lib/auth/security";
import {
  readTransaction,
  transaction,
  putRecord,
} from "../../lib/server/database";
import {
  recoverApplicationDocument,
  recoverOneDeferredDocument,
} from "../../lib/server/document-recovery";
import { getState, saveState } from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";

for (const name of [
  "AIVEN_DATABASE_URL",
  "DATABASE_POOL_URL",
  "DATABASE_URL",
  "VERCEL",
  "GEMINI_API_KEY",
])
  delete process.env[name];
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-document-recovery-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "HR Fixture",
  title: "HR",
  role: "Admin",
  active: true,
};

test("deferred Gmail resume recovery persists the real extracted name and education without changing HR decisions", async () => {
  const bytes = Buffer.from(
    "FULL NAME: Fictional Alison D. Example\nEDUCATION\nHigh school graduate\nCONTACT\n09123456789\nWORK EXPERIENCE\nCustomer service at Example Coffee.",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const at = new Date().toISOString();
  const state = initialState();
  const application: Application = {
    id: "DJC-FIXTURE-00001",
    applicant: {
      id: "fixture-person",
      name: "Writing To Express My Interest In The Job",
      email: "fixture@example.invalid",
      phone: "",
      location: "Not verified",
      experience: 0,
    },
    position:
      "Applied position was not clearly stated in the submitted application.",
    location:
      "Preferred work location was not clearly stated in the submitted application.",
    appliedAt: at,
    stage: "Screening",
    status: "New",
    screening: { outcome: "Requires Review", completedAt: "", criteria: [] },
    lastActivity: at,
    notes: [],
    interviews: [],
    requirements: [],
    timeline: [],
    onboardingStatus: "Pending Orientation",
    resumeId: "fixture-resume",
    resumeHash: hash,
    extraction: {
      method: "text",
      warnings: [
        "Resume processing was deferred so Gmail intake could continue.",
      ],
    },
    information: {
      fields: {
        name: {
          source: "Email body",
          evidence: "I am writing",
          confidence: "Confident",
        },
      },
      conflicts: [],
    },
  };
  await transaction(async (tx) => {
    await tx.query(
      "INSERT INTO resumes(id,sha256,filename,mime,content,extracted_text) VALUES($1,$2,$3,$4,$5,$6)",
      [
        "fixture-resume",
        hash,
        "fixture.txt",
        "text/plain",
        "",
        seal("", process.env.TOKEN_ENCRYPTION_KEY!),
      ],
    );
    await tx.query(
      "INSERT INTO resume_sources(resume_id,provider,gmail_message_id,created_at) VALUES($1,$2,$3,$4)",
      ["fixture-resume", "gmail", "fixture-message", at],
    );
    state.applications.push(application);
    await saveState(tx, state, { sync: false });
    await putRecord(
      tx,
      "application_sources",
      application.id,
      seal(
        {
          subject: "Job Application",
          body: "I am writing to express my interest in the job that I saw in your post.",
          from: "<fixture@example.invalid>",
          filename: "fixture.txt",
        },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
  });
  const recovered = await recoverOneDeferredDocument((id) =>
    recoverApplicationDocument(id, user, async () => bytes),
  );
  assert.equal(recovered, true);
  const saved = await readTransaction(async (tx) => ({
    application: (await getState(tx)).applications[0],
    resume: (
      await tx.query("SELECT extracted_text,content FROM resumes WHERE id=$1", [
        "fixture-resume",
      ])
    )[0],
  }));
  assert.equal(saved.application.applicant.name, "Fictional Alison D. Example");
  assert.match(
    saved.application.applicant.education || "",
    /High school graduate/i,
  );
  assert.equal(saved.application.screening.outcome, "Requires Review");
  assert.equal(saved.application.stage, "Screening");
  assert.equal(saved.application.extraction?.warnings.length, 0);
  assert.match(
    unseal<string>(
      String(saved.resume.extracted_text),
      process.env.TOKEN_ENCRYPTION_KEY!,
    ),
    /Fictional Alison/,
  );
  assert.equal(saved.resume.content, "");
  assert.equal(
    (
      await readTransaction((tx) =>
        tx.query("SELECT id FROM records WHERE collection='extraction_jobs'"),
      )
    ).length,
    0,
  );
});
