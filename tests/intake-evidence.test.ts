import test from "node:test";
import assert from "node:assert/strict";
import { intakeEvidence } from "../lib/intake-evidence";
test("applied position and branch do not depend on a configured hiring need", () => {
  const r = intakeEvidence({
    subject: "Barista application — Naga City",
    from: '"Fictional Applicant" <fixture@example.invalid>',
    resume: "Address: Santa Rosa, Laguna",
  });
  assert.equal(r.position, "Barista");
  assert.equal(r.location, "Naga City");
  assert.equal(r.name, "Fictional Applicant");
  assert.equal(
    intakeEvidence({ subject: "Application for Production Operator" }).position,
    "Production Operator",
  );
  assert.equal(
    intakeEvidence({ subject: "Application for Barista/Cashier at Naga City" })
      .position,
    "Barista/Cashier",
  );
  assert.equal(
    intakeEvidence({ subject: "Application for Barista Staff position" })
      .position,
    "Barista Staff",
  );
});
test("residence never becomes preferred work location and missing evidence remains unknown", () => {
  const r = intakeEvidence({
    subject: "Application",
    body: "My home address is Naga City.",
    resume: "Barista at Example Coffee\nAddress: Santa Rosa, Laguna",
  });
  assert.equal(r.location, "Location requires review");
  assert.equal(r.position, "Position requires review");
  assert.equal(r.name, "Name requires review");
});
test("explicit preferences and conflicting submitted branches remain auditable", () => {
  const r = intakeEvidence({
    subject: "Application for Supervisor",
    body: "I am applying at Santa Rosa, Laguna branch.",
  });
  assert.equal(r.position, "Supervisor");
  assert.equal(r.location, "Santa Rosa, Laguna");
  const conflict = intakeEvidence({
    subject: "Barista Naga City",
    body: "My preferred branch is Santa Rosa, Laguna.",
  });
  assert.equal(conflict.location, "Location requires review");
  assert.equal(conflict.warnings.length, 1);
});
