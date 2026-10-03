import assert from "node:assert/strict";
// This mutation check is deliberately restricted to the fictional local QA workspace.
const base = process.env.QA_BASE_URL || "http://localhost:3004";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const headers = {
  "Content-Type": "application/json",
  Origin: base,
  Cookie: "dj_session=workflow-qa-session",
};
const workspace = await (
  await fetch(`${base}/api/workspace`, { headers })
).json();
assert.equal(
  workspace.currentUser?.email,
  "admin@example.invalid",
  "Never run this check against real HR data",
);
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
const post = async (body) => {
  const response = await fetch(`${base}/api/issuance`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const runId = crypto.randomUUID();
const payload = {
  action: "create",
  requestId: crypto.randomUUID(),
  category: "Uniform",
  employeeName: `QA Double Submission ${runId}`,
  item: "QA Apron",
  quantity: 2,
  status: "Issued",
  issuedAt: "2026-10-03",
  signed: false,
  issuedBy: "QA Issuer",
};
await check("concurrent individual issuance creates one record", async () => {
  const results = await Promise.all([post(payload), post(payload)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.equal(results[0].body.record.id, results[1].body.record.id);
  const saved = await (
    await fetch(`${base}/api/workspace`, { headers })
  ).json();
  assert.equal(
    saved.issuance.filter((r) => r.employeeName === payload.employeeName)
      .length,
    1,
  );
});
await check("single issuance preserves issuer", async () => {
  const result = await post({
    ...payload,
    requestId: crypto.randomUUID(),
    employeeName: `QA Issuer Record ${runId}`,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.record.issuedBy, "QA Issuer");
});
await check(
  "invalid issuance dates are rejected without creating a record",
  async () => {
    const result = await post({
      ...payload,
      requestId: crypto.randomUUID(),
      employeeName: `QA Invalid Date ${runId}`,
      issuedAt: "2026-02-31",
    });
    assert.equal(result.status, 400);
    const saved = await (
      await fetch(`${base}/api/workspace`, { headers })
    ).json();
    assert.ok(
      !saved.issuance.some(
        (r) => r.employeeName === `QA Invalid Date ${runId}`,
      ),
    );
  },
);
await check(
  "changed retry payload is rejected and original issuance stays unchanged",
  async () => {
    assert.equal((await post({ ...payload, quantity: 3 })).status, 409);
    assert.equal((await post(payload)).body.record.quantity, 2);
  },
);
await check(
  "return and reissue preserve stock totals and issuer; invalid edits roll back",
  async () => {
    const created = (await post(payload)).body.record;
    const returned = await post({
      ...created,
      action: "update",
      status: "Returned",
      returnedAt: "2026-10-03",
    });
    assert.equal(returned.status, 200);
    const reissued = await post({
      ...returned.body.record,
      action: "update",
      status: "Issued",
      issuedBy: "Corrected QA Issuer",
    });
    assert.equal(reissued.status, 200);
    assert.equal(reissued.body.record.returnedAt, undefined);
    assert.equal(reissued.body.record.issuedBy, "Corrected QA Issuer");
    assert.equal(
      reissued.body.inventory[0].onHand,
      returned.body.inventory[0].onHand - 2,
    );
    assert.equal(
      (
        await post({
          ...reissued.body.record,
          action: "update",
          issuedAt: "2026-02-31",
        })
      ).status,
      400,
    );
    const saved = await (
      await fetch(`${base}/api/workspace`, { headers })
    ).json();
    assert.equal(
      saved.issuance.find((r) => r.id === created.id).issuedAt,
      "2026-10-03",
    );
  },
);
await check("expired and read-only sessions cannot issue", async () => {
  for (const cookie of ["final-qa-expired", "final-qa-role-1"]) {
    const response = await fetch(`${base}/api/issuance`, {
      method: "POST",
      headers: { ...headers, Cookie: `dj_session=${cookie}` },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, cookie === "final-qa-expired" ? 401 : 403);
  }
});
if (failures.length)
  throw Error(`${failures.length} issuance regressions failed`);
