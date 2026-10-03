import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Authenticated mutation tests only run in the named, fictional local QA fixture.
const base = process.env.QA_BASE_URL || "http://localhost:3004";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const headers = {
  Cookie: "dj_session=workflow-qa-session",
  Origin: base,
  "Content-Type": "application/json",
};
async function request(path, method = "GET", body, custom = headers) {
  const r = await fetch(base + path, {
    method,
    headers: custom,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  return { status: r.status, data };
}
async function get(path) {
  const r = await request(path);
  assert.equal(r.status, 200, `${path}: ${r.data.error}`);
  return r.data;
}
const state = await get("/api/workspace");
assert.equal(
  state.currentUser?.email,
  "admin@example.invalid",
  "Refuse to mutate real HR data",
);
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const runId = crypto.randomUUID();
await check("all internal pages render for an authorized session", async () => {
  for (const path of [
    "/",
    "/applications",
    "/hiring-needs",
    "/talent-pool",
    "/timekeeping",
    "/people",
    "/issuance",
    "/reports",
    "/settings/preferences",
    "/settings/requirements",
    "/settings/qualifications",
    "/settings/email-templates",
    "/settings/users",
    "/settings/health",
    "/settings/diagnostics",
    "/settings/audit",
    "/settings/timekeeping",
    "/settings/retention",
    "/settings/integrations",
  ]) {
    const r = await fetch(base + path, { headers });
    assert.equal(r.status, 200, path);
    assert.ok((await r.text()).includes("Daily Joe"), path);
  }
});
await check(
  "indexed search, special characters, date filters and full roster counts agree",
  async () => {
    for (const q of [
      "juan",
      "JUAN DELA CRUZ",
      "  juan   dela   cruz ",
      "qa12@example.invalid",
      "09170000012",
      "100%_QA",
      "O'Neil",
    ]) {
      const result = await get(`/api/applications?q=${encodeURIComponent(q)}`);
      assert.equal(result.total, 1, q);
    }
    assert.equal((await get("/api/applications?talent=1")).total, 30);
    assert.equal((await get("/api/applications?tab=Hired")).total, 45);
    assert.equal(
      (await get("/api/issuance?onboarding=1")).applications.length,
      45,
    );
    const month = await get(
      "/api/applications?since=2026-09-30T16%3A00%3A00.000Z",
    );
    assert.equal(
      month.total,
      Object.values(state.applicationSummary.real.currentMonthByStatus).reduce(
        (a, b) => a + b,
        0,
      ),
    );
    const times = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      await get(
        "/api/applications?q=qa&position=Barista&location=Naga%20City&page=2",
      );
      times.push(Math.round(performance.now() - start));
    }
    console.log(
      `Local warm search latency: min=${Math.min(...times)}ms max=${Math.max(...times)}ms mean=${Math.round(times.reduce((a, b) => a + b) / times.length)}ms`,
    );
  },
);
let createdId;
await check(
  "manual applicant create is idempotent; duplicate and invalid emails fail safely",
  async () => {
    const body = {
      requestId: runId,
      name: "QA Created Person",
      email: `created-${runId}@example.invalid`,
      phone: "09181112222",
      position: "Barista",
      location: "Naga City",
      notes: "QA",
      hiringNeedId: "qa-need",
    };
    const results = await Promise.all([
      request("/api/applicants", "POST", body),
      request("/api/applicants", "POST", body),
    ]);
    results.forEach((r) => assert.equal(r.status, 200, r.data.error));
    createdId = results[0].data.id;
    assert.ok(createdId);
    assert.equal(createdId, results[1].data.id);
    assert.equal(
      (
        await request("/api/applicants", "POST", {
          ...body,
          requestId: crypto.randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/api/applicants", "POST", {
          ...body,
          requestId: crypto.randomUUID(),
          email: "not an email",
        })
      ).status,
      400,
    );
  },
);
await check(
  "filtered bulk note affects all pages exactly once; export returns a workbook",
  async () => {
    const filters = "q=qa&position=Barista&location=Naga%20City&status=New";
    const selection = await get(`/api/applications?${filters}&selection=ids`),
      before = await get("/api/workspace");
    assert.ok(selection.ids.length > 20);
    const body = {
      requestId: crypto.randomUUID(),
      ids: selection.ids,
      filters,
      allFiltered: true,
      revision: before.revision,
      action: "note",
      reason: `QA filtered note ${runId}`,
      confirmed: true,
    };
    const result = await request("/api/applicants/bulk", "POST", body);
    assert.equal(result.status, 200, result.data.error);
    assert.equal(result.data.updated, selection.ids.length);
    assert.equal(
      (await request("/api/applicants/bulk", "POST", body)).data.updated,
      selection.ids.length,
    );
    for (const id of [selection.ids[0], selection.ids.at(-1)]) {
      const a = await get(`/api/applicants/${id}`);
      assert.equal(a.notes.filter((n) => n === body.reason).length, 1);
    }
    assert.ok(
      !(await get("/api/applicants/QA-0012")).notes.includes(body.reason),
    );
    const now = await get("/api/workspace");
    const r = await fetch(base + "/api/applicants/bulk", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        requestId: crypto.randomUUID(),
        revision: now.revision,
        action: "export",
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type").includes("spreadsheet"));
    assert.ok((await r.arrayBuffer()).byteLength > 1000);
  },
);
await check(
  "talent pool movement, restoration, reject and withdraw persist without duplicate membership",
  async () => {
    for (const action of ["talent", "status", "withdraw"]) {
      const before = await get("/api/workspace");
      const r = await request("/api/applicants/bulk", "POST", {
        requestId: crypto.randomUUID(),
        ids: [createdId],
        filters: "",
        revision: before.revision,
        action,
        value: "New",
        reason: "QA decision",
        confirmed: true,
      });
      assert.equal(r.status, 200, r.data.error);
      const a = await get(`/api/applicants/${createdId}`);
      assert.equal(
        a.status,
        { talent: "Talent Pool", status: "New", withdraw: "Withdrawn" }[action],
      );
    }
    const before = await get("/api/workspace");
    const rejected = await request("/api/applicants/bulk", "POST", {
      requestId: crypto.randomUUID(),
      ids: ["QA-0249"],
      filters: "",
      revision: before.revision,
      action: "reject",
      reason: "QA reject",
      confirmed: true,
    });
    assert.equal(rejected.status, 200, rejected.data.error);
    assert.equal((await get("/api/applicants/QA-0249")).status, "Rejected");
  },
);
await check(
  "soft deletion requires confirmation, hides record and restores it",
  async () => {
    const before = await get("/api/workspace"),
      body = {
        requestId: crypto.randomUUID(),
        ids: [createdId],
        filters: "",
        revision: before.revision,
        action: "delete",
        reason: "QA deletion",
        confirmed: true,
      };
    assert.equal(
      (await request("/api/applicants/bulk", "POST", body)).status,
      400,
    );
    const r = await request("/api/applicants/bulk", "POST", {
      ...body,
      typedConfirmation: "DELETE 1",
    });
    assert.equal(r.status, 200, r.data.error);
    assert.equal((await request(`/api/applicants/${createdId}`)).status, 404);
    assert.ok(
      (await get("/api/applicants")).records.some((a) => a.id === createdId),
    );
    assert.equal(
      (
        await request(`/api/applicants/${createdId}`, "POST", {
          confirmed: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await get(`/api/applicants/${createdId}`)).status,
      "Withdrawn",
    );
  },
);
await check("hiring need create, edit, close and reopen persist", async () => {
  const body = {
    position: "QA Barista",
    location: "Naga City",
    slots: 3,
    urgency: "Medium",
    targetDate: "2026-10-31",
    status: "Open",
    questions: "QA",
    criteria: [],
  };
  const created = await request("/api/hiring-needs", "POST", body);
  assert.equal(created.status, 200, created.data.error);
  for (const status of ["Closed", "Open"]) {
    const r = await request("/api/hiring-needs", "PATCH", {
      ...body,
      id: created.data.hiringNeed.id,
      slots: 4,
      status,
    });
    assert.equal(r.status, 200, r.data.error);
    assert.equal(r.data.hiringNeed.status, status);
    assert.equal(r.data.hiringNeed.slots, 4);
  }
});
await check(
  "onboarding requirement and status changes survive independent reads",
  async () => {
    const a = await get("/api/applicants/QA-0250");
    a.requirements[0].status = "Complete";
    a.requirements[0].notes = "QA verified requirement";
    a.onboardingStatus = "Completed";
    a.orientationDate = "2026-10-01";
    a.commitmentDate = "2026-10-03";
    const r = await request(`/api/applicants/${a.id}/workflow`, "PUT", {
      application: a,
      confirmed: true,
    });
    assert.equal(r.status, 200, r.data.error);
    const saved = await get(`/api/applicants/${a.id}`);
    assert.equal(saved.requirements[0].status, "Complete");
    assert.equal(saved.requirements[0].notes, "QA verified requirement");
    assert.equal(saved.onboardingStatus, "Completed");
  },
);
await check(
  "existing applicant extraction preview protects HR identity and applies only selected fields",
  async () => {
    const before = await get("/api/applicants/QA-0012"),
      r = await request("/api/applicants/reprocess", "POST", {
        action: "preview",
        ids: [before.id],
      });
    assert.equal(r.status, 200, r.data.error);
    const changes = r.data.changes.filter(
      (c) => c.field === "phone" && !c.protected,
    );
    assert.equal(changes.length, 1);
    const applied = await request("/api/applicants/reprocess", "POST", {
      action: "apply",
      id: r.data.id,
      selected: [`${before.id}:phone`],
      confirmed: true,
    });
    assert.equal(applied.status, 200, applied.data.error);
    const after = await get(`/api/applicants/${before.id}`);
    assert.equal(after.applicant.name, before.applicant.name);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.notes, before.notes);
    assert.equal(after.hiringNeedId, before.hiringNeedId);
    assert.equal(after.applicant.phone, "09181112222");
  },
);
await check(
  "bulk issuance creates individual linked records and concurrent retry is idempotent",
  async () => {
    const roster = await get("/api/issuance"),
      keys = roster.employees
        .filter((p) => p.applicationId)
        .slice(0, 3)
        .map((p) => p.key);
    assert.equal(keys.length, 3);
    const body = {
      action: "bulk-create",
      requestId: crypto.randomUUID(),
      employeeKeys: keys,
      category: "Uniform",
      item: "QA Apron",
      quantity: 1,
      issuedAt: "2026-10-03",
      issuedBy: "QA Bulk Issuer",
      condition: "New",
      notes: "QA bulk",
      confirmed: true,
    };
    const results = await Promise.all([
      request("/api/issuance", "POST", body),
      request("/api/issuance", "POST", body),
    ]);
    results.forEach((r) => assert.equal(r.status, 200, r.data.error));
    assert.deepEqual(
      results[0].data.records.map((r) => r.id),
      results[1].data.records.map((r) => r.id),
    );
    assert.equal(results[0].data.records.length, 3);
    results[0].data.records.forEach((r) => {
      assert.ok(r.applicationId);
      assert.equal(r.issuedBy, "QA Bulk Issuer");
      assert.equal(r.condition, "New");
    });
    const saved = await get("/api/workspace");
    assert.equal(
      saved.issuance.filter((r) => r.batchId === body.requestId).length,
      3,
    );
  },
);
await check(
  "preferences save, behavior and restoration persist; invalid timezone is rejected",
  async () => {
    const before = (await get("/api/workspace")).preferences;
    const r = await request("/api/workspace", "PATCH", {
      preferences: {
        ...before,
        dateFormat: "en-US",
        timezone: "UTC",
        theme: "dark",
      },
    });
    assert.equal(r.status, 200, r.data.error);
    assert.equal((await get("/api/workspace")).preferences.timezone, "UTC");
    assert.equal(
      (
        await request("/api/workspace", "PATCH", {
          preferences: { timezone: "Invalid/Timezone" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/workspace", "PATCH", { preferences: before }))
        .status,
      200,
    );
  },
);
await check(
  "backend role boundaries, expired session and cross-origin mutations are enforced",
  async () => {
    const application = await get("/api/applicants/QA-0250");
    for (const token of ["final-qa-role-1", "final-qa-role-2"])
      assert.equal(
        (
          await request(
            "/api/applicants/QA-0250/workflow",
            "PUT",
            { application, confirmed: true },
            { ...headers, Cookie: `dj_session=${token}` },
          )
        ).status,
        403,
      );
    for (const [token, timeStatus, issueStatus] of [
      ["final-qa-role-1", 403, 403],
      ["final-qa-role-2", 200, 403],
      ["final-qa-role-3", 403, 200],
      ["final-qa-role-4", 200, 200],
    ]) {
      const h = { ...headers, Cookie: `dj_session=${token}` };
      assert.equal(
        (await request("/api/timekeeping", "GET", undefined, h)).status,
        timeStatus,
      );
      assert.equal(
        (await request("/api/issuance", "GET", undefined, h)).status,
        200,
      );
      const invalid = await request(
        "/api/issuance",
        "POST",
        { action: "unknown" },
        h,
      );
      assert.equal(invalid.status, issueStatus === 403 ? 403 : 400);
    }
    assert.equal(
      (
        await request("/api/workspace", "GET", undefined, {
          ...headers,
          Cookie: "dj_session=final-qa-expired",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/issuance",
          "POST",
          {},
          { ...headers, Origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
  },
);
await check(
  "1,428-record cutoff retains sources and bulk resolves only selected overtime",
  async () => {
    const batch = (await get("/api/timekeeping?batch=qa-realistic-cutoff"))
      .batch;
    assert.equal(batch.records.length, 1428);
    assert.equal(
      batch.records.filter((r) => r.review.status === "Resolved").length,
      1240,
    );
    const overtime = batch.records.filter(
      (r) => r.results.includes("Overtime") && r.review.status === "For Review",
    );
    assert.ok(overtime.length > 20);
    const r = await request("/api/timekeeping", "POST", {
      action: "bulk-review",
      id: batch.id,
      revision: batch.revision,
      allFiltered: true,
      filters: { result: "Overtime", status: "For Review" },
      expectedCount: overtime.length,
      operation: "confirm-overtime",
      note: "QA verified overtime",
      confirmed: true,
    });
    assert.equal(r.status, 200, r.data.error);
    const saved = (await get(`/api/timekeeping?batch=${batch.id}`)).batch;
    for (const id of overtime.map((r) => r.id)) {
      const row = saved.records.find((r) => r.id === id);
      assert.equal(row.review.status, "Resolved");
      assert.equal(row.review.history.length, 1);
      assert.deepEqual(row.raw, batch.records.find((r) => r.id === id).raw);
    }
    assert.equal(
      saved.records.filter((r) => r.review.history.length).length,
      overtime.length,
    );
  },
);
async function waitJob(id) {
  for (let i = 0; i < 50; i++) {
    const { job } = await get(`/api/timekeeping?job=${id}`);
    if (job.status === "Completed") return job;
    assert.notEqual(job.status, "Failed", job.error);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Attendance job did not settle");
}
await check(
  "actual XLSX upload, analysis, repeat import and manual resolution are preserved",
  async () => {
    async function upload() {
      const form = new FormData();
      for (const [key, file] of [
        ["attendance", "Attendance"],
        ["pivot", "Pivot"],
      ])
        form.append(
          key,
          new File(
            [readFileSync(`test-results/final-qa-${file}.xlsx`)],
            `${file}.xlsx`,
          ),
        );
      const r = await fetch(base + "/api/timekeeping", {
        method: "POST",
        headers: { Cookie: headers.Cookie, Origin: base },
        body: form,
      });
      assert.equal(r.status, 202);
      return waitJob((await r.json()).job.id);
    }
    const first = await upload(),
      second = await upload();
    assert.equal(first.id, second.id);
    const preview = first.result;
    const rules = {
      timezone: "Asia/Manila",
      start: "",
      end: "",
      graceMinutes: 0,
      overtimeMinutes: 30,
      overtimeRounding: "nearest",
      excessiveWorkedHours: 16,
      discrepancyMinutes: 1,
      expectedHours: null,
      workDays: [],
    };
    const analyzed = await request("/api/timekeeping", "POST", {
      action: "analyze",
      id: preview.id,
      rules,
      aliases: {},
    });
    assert.equal(analyzed.status, 202, analyzed.data.error);
    const job = await waitJob(analyzed.data.job.id);
    const batch = (await get(`/api/timekeeping?batch=${job.result.batchId}`))
      .batch;
    assert.equal(batch.records.length, 1);
    assert.ok(batch.records[0].results.includes("Overtime"));
    assert.equal(batch.records[0].calculation.creditedMinutes, 60);
    const saved = await request("/api/timekeeping", "POST", {
      action: "bulk-review",
      id: batch.id,
      revision: batch.revision,
      recordIds: [batch.records[0].id],
      expectedCount: 1,
      operation: "confirm-overtime",
      note: "QA manual resolution",
      confirmed: true,
    });
    assert.equal(saved.status, 200, saved.data.error);
    await upload();
    const again = (await get(`/api/timekeeping?batch=${batch.id}`)).batch;
    assert.equal(again.records.length, 1);
    assert.deepEqual(
      again.records[0].review,
      saved.data.batch.records[0].review,
    );
    assert.deepEqual(again.records[0].raw, saved.data.batch.records[0].raw);
  },
);
await check(
  "empty/malformed attendance upload fails gracefully without fake success",
  async () => {
    assert.equal(
      (
        await fetch(base + "/api/timekeeping", {
          method: "POST",
          headers: { Cookie: headers.Cookie, Origin: base },
          body: new FormData(),
        })
      ).status,
      400,
    );
    const form = new FormData();
    form.append("attendance", new File(["invalid"], "bad.xlsx"));
    form.append("pivot", new File(["invalid"], "bad.xlsx"));
    const r = await fetch(base + "/api/timekeeping", {
      method: "POST",
      headers: { Cookie: headers.Cookie, Origin: base },
      body: form,
    });
    assert.equal(r.status, 202);
    const id = (await r.json()).job.id;
    let terminal;
    for (let i = 0; i < 50; i++) {
      terminal = (await get(`/api/timekeeping?job=${id}`)).job;
      if (terminal.status === "Failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(terminal.status, "Failed");
    assert.ok(terminal.error);
    assert.ok(!terminal.error.includes("Error:"));
  },
);
if (failures.length)
  throw Error(`${failures.length} full-system QA checks failed`);
