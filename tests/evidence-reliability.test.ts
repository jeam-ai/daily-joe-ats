import test from "node:test";
import assert from "node:assert/strict";
import { intakeEvidence } from "../lib/intake-evidence";
import { screenResumeAgainstCriteria } from "../lib/screening";
import { evidenceInformation } from "../lib/applicant-information";
test("resume identity wins over sender display; residence and preference remain separate", () => {
  const result = intakeEvidence({
    subject: "Barista application",
    from: "Different Sender <fixture@example.invalid>",
    body: "Preferred work location: Naga City",
    resume:
      "Name: Fictional Resume Person\nAddress: Zone 3, Pili, Camarines Sur\nWORK EXPERIENCE\nBarista for 2 years\nEDUCATION\nHigh school graduate",
  });
  assert.equal(result.name, "Fictional Resume Person");
  assert.equal(result.location, "Naga City");
  assert.equal(result.residence, "Zone 3, Pili, Camarines Sur");
  assert.ok(result.warnings.some((w) => w.includes("conflict")));
  assert.equal(evidenceInformation(result).fields.name.confidence, "Confident");
  assert.equal(
    evidenceInformation(result).fields.location.source,
    "Email body",
  );
  const heading = intakeEvidence({
    subject: "Application",
    resume: "WORK HISTORY\nFictional Person\nBarista",
    from: "Sender Name <fixture@example.invalid>",
  });
  assert.equal(heading.name, "Fictional Person");
  assert.equal(
    evidenceInformation(heading).fields.name.confidence,
    "Uncertain",
  );
});
test("equivalent role wording still requires stated duration and absent content is not assessed", () => {
  const rules = [
    {
      id: "years",
      label: "Minimum of one year of barista experience",
      kind: "Minimum" as const,
      absenceFails: false,
    },
  ];
  assert.equal(
    screenResumeAgainstCriteria(
      "Cashier/barista for 2 years at Example Coffee",
      rules,
    )[0].result,
    "Met",
  );
  assert.equal(
    screenResumeAgainstCriteria("Seeking barista work for two years", rules)[0]
      .result,
    "Unclear",
  );
  assert.equal(
    screenResumeAgainstCriteria("Cashier/barista for 3 months", rules)[0]
      .result,
    "Unclear",
  );
  assert.equal(
    screenResumeAgainstCriteria("", rules)[0].result,
    "Not Assessed",
  );
});
