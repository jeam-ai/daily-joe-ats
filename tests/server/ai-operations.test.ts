import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord, readRecord } from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import {
  getState,
  publicState,
  updateState,
} from "../../lib/server/repository";
import { createApplicant } from "../../lib/server/applicants";
import {
  aiProfile,
  runAiAssist,
  setAiEnabled,
  aiUsage,
} from "../../lib/server/ai-assist";
import {
  AiProviderError,
  aiConfigured,
  classifyAiError,
  validateAiResult,
  type AiProvider,
} from "../../lib/server/ai-provider";
import { aiEligibility } from "../../lib/ai-assist";
import {
  recordIssue,
  resolveIssue,
  diagnosticHistory,
  recoveryAttempt,
  markDiagnostic,
} from "../../lib/server/diagnostics";
import { auditDetails, auditHistory } from "../../lib/server/audit";
import { cachedHealth } from "../../lib/server/health";
import { seal } from "../../lib/auth/security";
import type { User } from "../../types";
import type { AiResult } from "../../types/operations";
const root = process.cwd();
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.GEMINI_API_KEY;
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-ai-operations-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "HR Fixture",
  title: "HR",
  role: "Admin",
  active: true,
};
const result: AiResult = {
  summary: "Customer service is stated. Duration could not be determined.",
  clarifiedInformation: [],
  experience: [
    {
      interpretation: "Customer service is stated; duration is not available.",
      evidence: "Customer service at Example Coffee",
    },
  ],
  uncertainties: ["Duration could not be determined."],
  conflicts: [],
  verify: ["Confirm employment dates."],
};
let id = "",
  calls = 0;
const provider: AiProvider = {
  model: "fixture-flash",
  check: async () => {},
  analyze: async () => {
    calls++;
    return result;
  },
};
test("optional AI Assist lifecycle, caching, explicit retry, stale evidence, and isolation", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  id = (
    await createApplicant(
      {
        requestId: crypto.randomUUID(),
        name: "FICTIONAL Resume Fixture",
        email: "fixture@example.invalid",
        phone: "",
        position: "Barista",
        location: "Naga City",
        notes: "",
      },
      user,
    )
  ).id;
  await transaction(async (tx) => {
    const state = await getState(tx),
      a = state.applications[0];
    a.resumeId = "fixture-resume";
    a.resumeHash = "fixture-hash";
    a.extraction = {
      method: "ocr",
      confidence: 55,
      warnings: ["Partial extraction"],
    };
    a.screening.criteria = [
      {
        id: "one",
        requirement: "Customer service",
        result: "Unclear",
        evidence: "Confirm duration.",
      },
    ];
    await tx.query(
      "INSERT INTO resumes(id,sha256,filename,mime,content,extracted_text) VALUES($1,$2,$3,$4,$5,$6)",
      [
        a.resumeId,
        a.resumeHash,
        "fixture.txt",
        "text/plain",
        seal("", process.env.TOKEN_ENCRYPTION_KEY!),
        seal(
          "Customer service at Example Coffee",
          process.env.TOKEN_ENCRYPTION_KEY!,
        ),
      ],
    );
    await putRecord(tx, "workspace", "main", state);
  });
  const original = structuredClone(
    (await transaction(getState)).applications[0],
  );
  assert.equal(aiConfigured(), false);
  const off = await aiProfile(id, user);
  assert.equal(off.enabled, false);
  assert.equal(off.configured, false);
  assert.equal(calls, 0);
  assert.equal(off.eligible.length, 3);
  const missing = await runAiAssist(id, user);
  assert.equal(missing.status, "Failed");
  assert.equal(missing.errorCode, "not_configured");
  assert.deepEqual((await transaction(getState)).applications[0], original);
  process.env.GEMINI_API_KEY = "fixture-not-real";
  assert.equal(aiConfigured(), true);
  await setAiEnabled(id, user, false);
  assert.equal((await aiProfile(id, user)).enabled, false);
  assert.equal(calls, 0);
  await setAiEnabled(id, user, true);
  assert.equal(calls, 0, "enabling never consumes a request");
  const completed = await runAiAssist(id, user, false, provider);
  assert.equal(completed.status, "Completed");
  assert.equal(calls, 1);
  await aiProfile(id, user);
  await runAiAssist(id, user, false, provider);
  assert.equal(calls, 1, "reads and cached operations cannot invoke provider");
  await runAiAssist(id, user, true, provider);
  assert.equal(calls, 2, "fresh analysis must be explicit");
  for (const code of [
    "rate_limit",
    "timeout",
    "invalid_response",
    "provider",
  ] as const) {
    const failed = await runAiAssist(id, user, true, {
      ...provider,
      analyze: async () => {
        throw new AiProviderError(code);
      },
    });
    assert.equal(failed.status, "Failed");
    assert.equal(failed.errorCode, code);
    assert.deepEqual((await transaction(getState)).applications[0], original);
  }
  const retry = await runAiAssist(id, user, false, provider);
  assert.equal(retry.status, "Completed");
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.applications[0].applicant.phone = "fixture changed";
    await putRecord(tx, "workspace", "main", state);
  });
  assert.equal((await aiProfile(id, user)).stale, true);
  const before = calls;
  await runAiAssist(id, user, false, provider);
  assert.equal(calls, before + 1);
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let invoked!: () => void;
  const started = new Promise<void>((r) => {
    invoked = r;
  });
  const running = runAiAssist(id, user, true, {
    ...provider,
    analyze: async () => {
      calls++;
      invoked();
      await blocked;
      return result;
    },
  });
  await started;
  const duplicate = await runAiAssist(id, user, true, provider);
  assert.equal(duplicate.status, "Running");
  const concurrentCalls = calls;
  release();
  await running;
  assert.equal(calls, concurrentCalls);
  await assert.rejects(
    runAiAssist(id, { ...user, role: "Viewer" }, true, provider),
    /permission/,
  );
  const usage = await aiUsage();
  assert.ok(usage.requests >= 8);
  assert.ok(usage.completed >= 3);
  assert.ok(usage.failed >= 5);
  const history = await auditHistory(
    user,
    new URLSearchParams({ applicant: id }),
  );
  assert.ok(history.events.some((e) => e.action === "ai.completed"));
  assert.ok(history.events.some((e) => e.action === "ai.failed"));
  const current = (await transaction(getState)).applications[0];
  assert.equal(current.stage, original.stage);
  assert.deepEqual(current.screening, original.screening);
  assert.deepEqual(current.requirements, original.requirements);
});
test("structured responses reject malformed, incomplete, invented quotes and decision language", () => {
  assert.deepEqual(
    validateAiResult(
      JSON.stringify(result),
      "Customer service at Example Coffee",
    ),
    result,
  );
  for (const raw of [
    "not json",
    "{}",
    JSON.stringify({
      ...result,
      experience: [
        { interpretation: "Invented job", evidence: "Imaginary employer" },
      ],
    }),
    JSON.stringify({ ...result, summary: "This applicant should be hired." }),
    JSON.stringify({ ...result, summary: "Best Candidate" }),
    JSON.stringify({ ...result, summary: "Hire" }),
    JSON.stringify({ ...result, summary: "Reject" }),
    JSON.stringify({ ...result, summary: "We recommend this candidate." }),
  ])
    assert.throws(
      () => validateAiResult(raw, "Customer service at Example Coffee"),
      /could not be verified/,
    );
  assert.equal(classifyAiError({ status: 429 }).code, "rate_limit");
  assert.equal(
    classifyAiError(new DOMException("secret provider details", "TimeoutError"))
      .code,
    "timeout",
  );
  assert.equal(
    classifyAiError({ status: 499, message: "operation cancelled" }).code,
    "timeout",
  );
  assert.equal(
    classifyAiError({ status: 504, message: "deadline exceeded" }).code,
    "timeout",
  );
  assert.doesNotMatch(
    classifyAiError(Error("secret token")).message,
    /secret token/,
  );
});
test("all diagnostic failure classes group, retain history, recover and respect audit permissions", async () => {
  for (const category of [
    "gmail.timeout",
    "gmail.authorization",
    "ai.rate_limit",
    "ai.timeout",
    "documents.extraction",
    "sheets.sync",
    "database.unavailable",
    "jobs.failure",
    "notification.failed",
    "export.failed",
    "timekeeping.failed",
    "server.failure",
  ] as const) {
    await recordIssue(category);
    await recordIssue(category);
  }
  let issues = await diagnosticHistory();
  const timeout = issues.find((i) => i.category === "gmail.timeout")!;
  assert.equal(timeout.occurrences, 2);
  await recoveryAttempt("gmail.timeout");
  await resolveIssue("gmail.timeout", {}, true);
  issues = await diagnosticHistory();
  assert.equal(
    issues.find((i) => i.id === timeout.id)?.status,
    "Automatically Resolved",
  );
  assert.equal(issues.find((i) => i.id === timeout.id)?.recoveryAttempts, 1);
  await recordIssue("gmail.timeout");
  assert.equal(
    (await diagnosticHistory()).find((i) => i.id === timeout.id)?.status,
    "Recurring",
  );
  await assert.rejects(
    markDiagnostic(timeout.id, user.email, "ok"),
    /Describe/,
  );
  await markDiagnostic(
    timeout.id,
    user.email,
    "Verified successful mailbox check manually.",
  );
  assert.equal(
    (await diagnosticHistory()).find((i) => i.id === timeout.id)?.status,
    "Closed",
  );
  const sanitized = JSON.stringify(
    auditDetails({
      apiKey: "secret",
      authorization: "secret",
      prompt: "private resume",
      nested: { accessToken: "secret" },
      message: "Bearer abc-secret",
      safe: "Kept",
    }),
  );
  assert.doesNotMatch(sanitized, /abc-secret|private resume|secret/);
  assert.match(sanitized, /Kept/);
  await assert.rejects(
    auditHistory({ ...user, role: "Viewer" }, new URLSearchParams()),
    /applicant/,
  );
  const viewer = await auditHistory(
    { ...user, role: "Viewer" },
    new URLSearchParams({ applicant: id }),
  );
  assert.ok(viewer.events.every((e) => e.entityId === id));
  const filtered = await auditHistory(
    user,
    new URLSearchParams({ search: "fixture", module: "ai" }),
  );
  assert.ok(filtered.events.every((e) => e.module === "ai"));
  const health = await cachedHealth();
  assert.ok(
    health.checks.every((c) => c.status === "Not Verified"),
    "no fabricated healthy defaults",
  );
  const state = await publicState(user);
  const notification = state.notifications.find((n) =>
    n.id.startsWith("diagnostic-"),
  )!;
  assert.ok(notification, "important recorded failures create notifications");
  notification.read = true;
  await updateState(state, user, true);
  assert.equal(
    (await publicState(user)).notifications.find(
      (n) => n.id === notification.id,
    )?.read,
    true,
  );
  assert.equal(
    (await publicState({ ...user, id: "second-admin" })).notifications.find(
      (n) => n.id === notification.id,
    )?.read,
    false,
  );
  const issue = (await diagnosticHistory()).find(
    (i) => `diagnostic-${i.id}` === notification.id,
  )!;
  await recordIssue(issue.category as Parameters<typeof recordIssue>[0], {
    entityId: issue.entityId,
    jobId: issue.jobId,
  });
  assert.equal(
    (await publicState(user)).notifications.find(
      (n) => n.id === notification.id,
    )?.read,
    false,
    "a later occurrence needs a fresh acknowledgement",
  );
});
test("intake does not invoke manual AI Assist and Timekeeping has no provider calls; key remains server-only", () => {
  for (const file of [
    "lib/google/gmail/intake.ts",
    "lib/google/gmail/sync.ts",
    "lib/server/odoo.ts",
    "app/api/timekeeping/route.ts",
    "app/api/applicants/[id]/resume/route.ts",
  ]) {
    const code = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(
      code,
      /assessWithAI|geminiProvider|runAiAssist|generateContent/,
    );
  }
  for (const file of [
    "components/ai-assist.tsx",
    "components/operations.tsx",
  ]) {
    const code = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(code, /GEMINI_API_KEY|NEXT_PUBLIC.*KEY|@google\/genai/);
  }
  const code = readFileSync(
    path.join(root, "lib/server/ai-provider.ts"),
    "utf8",
  );
  assert.match(code, /import "server-only"/);
  assert.match(code, /attempts:\s*1/);
});
