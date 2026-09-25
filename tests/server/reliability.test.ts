import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  transaction,
  readTransaction,
  putRecord,
  readRecord,
} from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import {
  getState,
  saveState,
  publicState,
  visibleState,
  updateState,
} from "../../lib/server/repository";
import { createApplicant } from "../../lib/server/applicants";
import {
  proceedApplicant,
  deliverEmail,
  emailHistory,
  verifySentEmail,
  queueEmail,
} from "../../lib/server/email-outbox";
import { withStore } from "../../lib/server/store";
import { listApplications } from "../../lib/server/application-list";
import {
  queueExtraction,
  runExtractionJobs,
  extractionStatus,
  validateExtraction,
  configureExtraction,
} from "../../lib/server/ai-extraction";
import { AiProviderError } from "../../lib/server/ai-provider";
import { seal } from "../../lib/auth/security";
import { activeIntake } from "../../lib/data-policy";
import { defaultEmailTemplate, renderEmail } from "../../lib/email-templates";
import {
  createTimekeepingJob,
  runTimekeepingJob,
  getTimekeepingJob,
} from "../../lib/server/timekeeping-jobs";
import { getOdooBatch } from "../../lib/server/odoo";
import { defaultOdooRules } from "../../lib/odoo";
import type { Application, User } from "../../types";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_SHEETS_ID;
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-reliability-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "QA Admin",
  role: "Admin",
  title: "HR",
  active: true,
};
async function applicant(n: string) {
  const { id } = await createApplicant(
    {
      requestId: crypto.randomUUID(),
      name: `FICTIONAL ${n}`,
      email: `${n}@example.invalid`,
      phone: "",
      position: "Barista",
      location: "Naga City",
      residence: "Pili",
      notes: "",
    },
    user,
  );
  return id;
}
async function current(id: string) {
  return (await readTransaction(getState)).applications.find(
    (a) => a.id === id,
  )!;
}
test("latest 100 membership, promotion, indexed server pages and HR source protection", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  const id = await applicant("queue");
  const base = await current(id);
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.applications = [
      { ...base, deletedAt: new Date().toISOString() },
      ...Array.from({ length: 105 }, (_, i) => ({
        ...structuredClone(base),
        id: `window-${String(i).padStart(3, "0")}`,
        applicant: {
          ...base.applicant,
          id: `person-${i}`,
          email: `window${i}@example.invalid`,
        },
        appliedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        timeline: [],
      })),
    ];
    await saveState(tx, state, { sync: false });
  });
  let state = await readTransaction(getState);
  assert.equal(state.applications.filter(activeIntake).length, 100);
  assert.equal(
    state.applications.find((a) => a.id === "window-000")?.queueState,
    "Queued",
  );
  const first = await listApplications(
    new URLSearchParams({ tab: "Active", page: "1" }),
  );
  assert.equal(first.total, 100);
  assert.equal(first.applications.length, 20);
  assert.equal(first.applications[0].id, "window-104");
  const second = await listApplications(
    new URLSearchParams({ tab: "Active", page: "2" }),
  );
  assert.equal(second.applications[0].id, "window-084");
  assert.equal(
    (await listApplications(new URLSearchParams({ tab: "Queued" }))).total,
    5,
  );
  assert.equal(
    (
      await listApplications(
        new URLSearchParams({ tab: "All applications", q: "window-104" }),
      )
    ).total,
    1,
  );
  assert.equal(
    (await listApplications(new URLSearchParams({ q: "%' OR 1=1 --" }))).total,
    0,
  );
  await transaction(async (tx) => {
    state = await getState(tx);
    state.applications.find((a) => a.id === "window-104")!.status = "Rejected";
    await saveState(tx, state, { sync: false });
  });
  state = await readTransaction(getState);
  assert.equal(
    state.applications.find((a) => a.id === "window-004")?.queueState,
    "Active",
  );
  assert.equal(state.applications.filter(activeIntake).length, 100);
  const incoming = await publicState(user);
  const a = incoming.applications.find((a) => a.id === "window-103")!;
  a.applicant.location = "Verified home address";
  a.information = {
    fields: {
      name: {
        source: "Forged",
        evidence: "Forged",
        confidence: "Confident",
        verifiedBy: "forged",
      },
    },
    conflicts: [],
  };
  await updateState(incoming, user, true);
  const saved = await current(a.id);
  assert.equal(saved.applicant.location, "Verified home address");
  assert.equal(saved.location, "Naga City");
  assert.equal(saved.information?.fields.residence.verifiedBy, user.email);
  assert.notEqual(saved.information?.fields.name.verifiedBy, "forged");
});
test("workspace bootstrap bounds application details and saves preserve omitted records", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  const sourceId = await applicant("workspace-preview-source");
  const source = await current(sourceId);
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.applications = Array.from({ length: 60 }, (_, index) => ({
      ...structuredClone(source),
      id: `workspace-preview-${String(index).padStart(2, "0")}`,
      applicant: {
        ...structuredClone(source.applicant),
        id: `workspace-person-${index}`,
        email: `workspace-preview-${index}@example.invalid`,
        name: `Preview Applicant ${index}`,
      },
      appliedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    }));
    await saveState(tx, state, { sync: false });
  });
  const full = await readTransaction(getState);
  const preview = visibleState(full, user);
  assert.equal(preview.applications.length, 50);
  assert.equal(preview.applicationSummary?.real.total, 60);
  await updateState(preview, user, true);
  assert.equal((await readTransaction(getState)).applications.length, 60);
});
test("Proceed commits one transition and one encrypted email, duplicate sends are fenced, failures retry without advancing twice", async () => {
  const id = await applicant("email");
  await withStore((s) => {
    s.officialConnection = {
      email: "careers@example.invalid",
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: Date.now() + 600000,
      connectedAt: new Date().toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
    };
  });
  const input = {
    expectedStage: "Screening",
    confirmed: true,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const [a, b] = await Promise.all([
    proceedApplicant(id, input, user),
    proceedApplicant(id, input, user),
  ]);
  assert.equal(a.emailId, b.emailId);
  assert.equal((await current(id)).interviews.length, 0);
  const original = globalThis.fetch;
  let sends = 0,
    mode = "rate";
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /messages\/send/);
    sends++;
    const raw = Buffer.from(
      JSON.parse(String(init?.body)).raw,
      "base64url",
    ).toString();
    assert.match(raw, /Message-ID: <djc-/);
    assert.doesNotMatch(raw, /\{\{/);
    return mode === "rate"
      ? Response.json({}, { status: 429 })
      : Response.json({ id: "sent123", threadId: "thread123" });
  };
  try {
    const failed = await deliverEmail(a.emailId!);
    assert.equal(failed.status, "Failed");
    assert.equal((await current(id)).stage, "Screening");
    assert.equal((await deliverEmail(a.emailId!)).status, "Failed");
    assert.equal(sends, 1);
    mode = "success";
    const results = await Promise.all([
      deliverEmail(a.emailId!, user, true),
      deliverEmail(a.emailId!, user, true),
    ]);
    assert.ok(results.some((r) => r.status === "Sent"));
    assert.equal((await current(id)).stage, "Initial Interview");
    assert.equal((await current(id)).interviews.length, 1);
    assert.equal(sends, 2);
    assert.equal((await deliverEmail(a.emailId!, user, true)).status, "Sent");
    assert.equal(sends, 2);
    const history = await emailHistory(id, user);
    assert.equal(history.length, 1);
    assert.equal(history[0].messageId, "sent123");
    assert.ok(history[0].body.includes("Fictional"));
    const stored = await readTransaction((tx) =>
      readRecord<string>(tx, "email_outbox", a.emailId!),
    );
    assert.ok(stored && !stored.includes("FICTIONAL"));
    await assert.rejects(
      proceedApplicant(id, input, { ...user, role: "Viewer" }),
      /manager/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("unknown email delivery is never resent and Gmail verification uses its actual sent timestamp", async () => {
  const id = await applicant("uncertain");
  const result = await proceedApplicant(
    id,
    {
      expectedStage: "Screening",
      confirmed: true,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    },
    user,
  );
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/send")) {
      sends++;
      throw new TypeError("network interrupted");
    }
    if (String(url).includes("format=metadata"))
      return Response.json({ internalDate: "1790000000000" });
    return Response.json({
      messages: [{ id: "verified", threadId: "verified-thread" }],
    });
  };
  try {
    assert.equal((await deliverEmail(result.emailId!)).status, "Unconfirmed");
    assert.equal(
      (await deliverEmail(result.emailId!, user, true)).status,
      "Unconfirmed",
    );
    assert.equal(sends, 1);
    const verified = await verifySentEmail(result.emailId!, user);
    assert.equal(verified.status, "Sent");
    assert.equal(verified.sentAt, new Date(1790000000000).toISOString());
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("unfinished templates remain failed without Gmail calls, and demo records cannot enter the outbox", async () => {
  const rendered = renderEmail(
    { subject: "{{ unknown }}", body: "Hello {{ first_name }}" },
    { first_name: "Fixture" },
  );
  assert.deepEqual(rendered.missing, ["unknown"]);
  const id = await applicant("template");
  await transaction(async (tx) => {
    const s = await getState(tx),
      a = s.applications.find((a) => a.id === id)!;
    const m = await queueEmail(
      tx,
      s,
      a,
      user,
      {
        ...defaultEmailTemplate("Initial Interview"),
        body: "{{ unavailable_field }}",
      },
      "missing",
      "Test",
    );
    assert.equal(m.status, "Failed");
    await assert.rejects(
      queueEmail(
        tx,
        s,
        { ...a, isDemo: true },
        user,
        defaultEmailTemplate("Hired"),
        "demo",
        "Test",
      ),
      /Demo/,
    );
    await saveState(tx, s, { sync: false });
  });
});
test("automatic extraction is separate, evidence-grounded, cached and cannot overwrite HR or qualification/stage data", async () => {
  const id = await applicant("extract");
  process.env.GEMINI_API_KEY = "fixture-only";
  await transaction(async (tx) => {
    const state = await getState(tx),
      a = state.applications.find((a) => a.id === id)!;
    a.location = "Location requires review";
    delete a.information?.fields.location;
    await putRecord(
      tx,
      "application_sources",
      id,
      seal(
        {
          body: "Preferred work location: Naga City. Residence: Bicol.",
          subject: "Barista application",
        },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
    await saveState(tx, state, { sync: false });
    await queueExtraction(tx, a);
    await queueExtraction(tx, a);
  });
  let calls = 0;
  const before = await current(id);
  await runExtractionJobs(2, {
    extract: async (sources) => {
      calls++;
      return validateExtraction(
        JSON.stringify({
          fields: [
            {
              field: "location",
              value: "Naga City",
              source: "email",
              evidence: "Preferred work location: Naga City",
              confidence: "Confident",
            },
            {
              field: "residence",
              value: "Bicol",
              source: "email",
              evidence: "Residence: Bicol",
              confidence: "Confident",
            },
          ],
          conflicts: [],
        }),
        sources,
      );
    },
  });
  const after = await current(id);
  assert.equal(calls, 1);
  assert.equal(after.location, "Naga City");
  assert.equal(after.applicant.location, "Pili");
  assert.deepEqual(after.screening, before.screening);
  assert.equal(after.stage, before.stage);
  assert.equal(
    (await extractionStatus()).jobs.filter((j) => j.applicationId === id)
      .length,
    1,
  );
  assert.throws(
    () =>
      validateExtraction(
        JSON.stringify({
          fields: [
            {
              field: "location",
              value: "Cebu",
              source: "email",
              evidence: "Naga City",
              confidence: "Confident",
            },
          ],
          conflicts: [],
        }),
        { email: "Naga City" },
      ),
    /Unsupported/,
  );
  await runExtractionJobs(2, {
    extract: async () => {
      throw Error("completed requests must not rerun");
    },
  });
  await configureExtraction(false, user);
  await transaction(async (tx) => {
    const a = await currentWithoutNested(tx, id);
    a.location = "Location requires review";
    await queueExtraction(tx, a);
  });
  assert.equal((await extractionStatus()).jobs.length, 1);
  await configureExtraction(true, user);
});
async function currentWithoutNested(
  tx: Parameters<Parameters<typeof transaction>[0]>[0],
  id: string,
) {
  return (await getState(tx)).applications.find((a) => a.id === id)!;
}
test("interrupted extraction fences late results and preserves subsequent HR changes", async () => {
  const id = await applicant("interrupted");
  await transaction(async (tx) => {
    const state = await getState(tx),
      a = state.applications.find((a) => a.id === id)!;
    a.location = "Location requires review";
    delete a.information?.fields.location;
    await putRecord(
      tx,
      "application_sources",
      id,
      seal(
        { body: "Preferred branch: Naga City", subject: "Application" },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
    await saveState(tx, state, { sync: false });
    await queueExtraction(tx, a);
  });
  const before = await current(id);
  await runExtractionJobs(1, {
    extract: async (sources) => {
      await transaction(async (tx) => {
        const rows = await tx.query(
          "SELECT id,payload FROM records WHERE collection=$1",
          ["extraction_jobs"],
        );
        const row = rows.find(
          (r) => JSON.parse(String(r.payload)).applicationId === id,
        )!;
        const job = JSON.parse(String(row.payload));
        job.leaseUntil = Date.now() - 1;
        await putRecord(tx, "extraction_jobs", String(row.id), job);
        const state = await getState(tx),
          a = state.applications.find((a) => a.id === id)!;
        a.location = "HR verified branch";
        a.information!.fields.location = {
          source: "HR",
          confidence: "Confident",
          evidence: "Verified with applicant",
          verifiedBy: user.email,
        };
        await saveState(tx, state, { sync: false });
      });
      assert.equal(
        (await extractionStatus()).jobs.find((j) => j.applicationId === id)!
          .status,
        "Failed",
      );
      return validateExtraction(
        JSON.stringify({
          fields: [
            {
              field: "location",
              value: "Naga City",
              source: "email",
              evidence: "Preferred branch: Naga City",
              confidence: "Confident",
            },
          ],
          conflicts: [],
        }),
        sources,
      );
    },
  });
  assert.equal((await current(id)).location, "HR verified branch");
  assert.equal((await current(id)).stage, before.stage);
  assert.equal(
    (await extractionStatus()).jobs.find((j) => j.applicationId === id)!.status,
    "Failed",
  );
});

test("Gemini quota failure preserves the applicant and persists a bounded backoff", async () => {
  const id = await applicant("quota");
  await transaction(async (tx) => {
    const s = await getState(tx),
      a = s.applications.find((a) => a.id === id)!;
    a.position = "Position requires review";
    await putRecord(
      tx,
      "application_sources",
      id,
      seal(
        { body: "Some submitted evidence", subject: "Application" },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
    await saveState(tx, s, { sync: false });
    await queueExtraction(tx, a);
  });
  const before = await current(id);
  let calls = 0;
  await runExtractionJobs(2, {
    extract: async () => {
      calls++;
      throw new AiProviderError("rate_limit", 429);
    },
  });
  await runExtractionJobs(2, {
    extract: async () => {
      calls++;
      throw Error();
    },
  });
  assert.equal(calls, 1);
  const job = (await extractionStatus()).jobs.find(
    (j) => j.applicationId === id,
  )!;
  assert.equal(job.status, "Failed");
  assert.ok(job.retryAt! > Date.now());
  assert.equal((await current(id)).stage, before.stage);
  assert.deepEqual((await current(id)).screening, before.screening);
  delete process.env.GEMINI_API_KEY;
});
test("large Odoo jobs preserve 900+ source rows, report progress and deduplicate concurrent execution", async () => {
  const raw = new ExcelJS.Workbook(),
    pivot = new ExcelJS.Workbook();
  const rs = raw.addWorksheet("Attendance"),
    ps = pivot.addWorksheet("Pivot");
  rs.addRow([
    "Employee",
    "Check In",
    "Check Out",
    "Worked Hours",
    "Over Time",
    "Extra Hours",
  ]);
  ps.addRows([
    [null, "September 2026"],
    [null, "Worked Hours", "Expected Hours", "Difference", "Balance"],
  ]);
  for (let i = 0; i < 65; i++) {
    const name = `FICTIONAL Employee ${i}`;
    ps.addRow([name, 120, 120, 0, 0]);
    for (let d = 1; d <= 15; d++) {
      const day = String(d).padStart(2, "0");
      rs.addRow([
        name,
        `2026-09-${day} 09:00:00`,
        `2026-09-${day} 17:00:00`,
        8,
        0,
        0,
      ]);
      ps.addRow([`${day} Sep 2026`, 8, 8, 0, 0]);
    }
  }
  const input = {
    kind: "upload" as const,
    attendance: {
      name: "Attendance.xlsx",
      bytes: Buffer.from(await raw.xlsx.writeBuffer()).toString("base64"),
    },
    pivot: {
      name: "Pivot.xlsx",
      bytes: Buffer.from(await pivot.xlsx.writeBuffer()).toString("base64"),
    },
  };
  const job = await createTimekeepingJob(input, user);
  assert.equal((await createTimekeepingJob(input, user)).id, job.id);
  await Promise.all([
    runTimekeepingJob(job.id, user),
    runTimekeepingJob(job.id, user),
  ]);
  const completed = await getTimekeepingJob(job.id, user);
  assert.equal(completed.status, "Completed");
  assert.equal(completed.attempts, 1);
  const preview = completed.result as { id: string; attendanceRows: number };
  assert.equal(preview.attendanceRows, 975);
  const analysis = await createTimekeepingJob(
    {
      kind: "analyze",
      id: preview.id,
      rules: defaultOdooRules,
      aliases: {},
      cutoff: { start: "2026-08-31", end: "2026-09-15" },
    },
    user,
  );
  await Promise.all([
    runTimekeepingJob(analysis.id, user),
    runTimekeepingJob(analysis.id, user),
  ]);
  const finished = await getTimekeepingJob(analysis.id, user);
  assert.equal(finished.status, "Completed");
  assert.equal(finished.progress, 100);
  assert.equal(finished.attempts, 1);
  const batch = await getOdooBatch(
    (finished.result as { batchId: string }).batchId,
    user,
  );
  assert.equal(batch.period.start, "2026-08-31");
  assert.equal(batch.period.end, "2026-09-15");
  assert.equal(batch.records.length, 1040);
  assert.equal(batch.records.flatMap((r) => r.raw).length, 975);
  await assert.rejects(
    getTimekeepingJob(job.id, { ...user, email: "other@example.invalid" }),
    /not found/,
  );
});
