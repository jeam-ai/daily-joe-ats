import test from "node:test";
import assert from "node:assert/strict";
import { intakeEvidence } from "../lib/intake-evidence";
import { screenResumeAgainstCriteria } from "../lib/screening";
import { evidenceInformation } from "../lib/applicant-information";
import { applyRecoveredResumeEvidence } from "../lib/applicant-information";
import type { Application } from "../types";
import { formalFact } from "../lib/formal-facts";
import { formalName } from "../lib/names";
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
test("an application sentence is not a name; recovered resume evidence replaces only unverified fields", () => {
  const email = intakeEvidence({
    subject: "Job Application",
    body: "I am writing to express my interest in the job that I saw in your post.",
    from: "<fixture@example.invalid>",
  });
  assert.doesNotMatch(email.name, /writing to express/i);
  const resume = intakeEvidence({
    subject: "Job Application",
    body: "I am writing to express my interest in the job that I saw in your post.",
    from: "<fixture@example.invalid>",
    resume:
      "FULL NAME: Fictional Alison D. Example\nEDUCATION\nHigh school graduate\nCONTACT\n09123456789",
  });
  assert.equal(resume.name, "Fictional Alison D. Example");
  assert.match(resume.education, /High school graduate/i);
  const application = {
    applicant: {
      name: "Writing To Express My Interest In The Job",
      phone: "",
      education: "",
      location: "Not verified",
    },
    position:
      "Applied position was not clearly stated in the submitted application.",
    location:
      "Preferred work location was not clearly stated in the submitted application.",
    information: {
      fields: { name: { source: "Email body", confidence: "Confident" } },
      conflicts: [],
    },
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, resume);
  assert.equal(application.applicant.name, resume.name);
  assert.equal(application.applicant.education, resume.education);
  assert.equal(application.applicant.phone, resume.phone);
  assert.equal(application.information?.fields.name?.source, "Resume");
  application.information!.fields.name!.verifiedBy = "hr@example.invalid";
  application.applicant.name = "HR Confirmed Name";
  applyRecoveredResumeEvidence(application, resume);
  assert.equal(application.applicant.name, "HR Confirmed Name");
});
test("resume contact locality and lowercase submitted facts are displayed formally", () => {
  const result = intakeEvidence({
    subject: "application for junior accounting analyst_naga branch",
    body: "i am interested in applying for the junior accounting analyst position in naga city.",
    from: "<fixture@example.invalid>",
    resume:
      "LUNA, VANESSA, FRANCISCO\nCONTACT\n0907 913 4791\nfixture@example.invalid\nsan roque, bombon,\ncamarines sur\nEDUCATION\nhigh school graduate",
  });
  assert.equal(result.name, "Vanessa Francisco Luna");
  assert.equal(result.residence, "San Roque, Bombon, Camarines Sur");
  assert.equal(evidenceInformation(result).fields.residence.source, "Resume");
  assert.equal(result.phone, "0907 913 4791");
  assert.equal(result.education, "High School Graduate");
  assert.equal(
    formalFact("position", "junior accounting analyst"),
    "Junior Accounting Analyst",
  );
  assert.equal(
    formalFact(
      "experienceDetails",
      "work experience in the social welfare field",
    ),
    "Work experience in the social welfare field",
  );
  assert.equal(
    formalName("LUNA, VANESSA, FRANCISCO"),
    "Vanessa Francisco Luna",
  );
});
test("built-in resume sections recover skills and job history without AI", () => {
  const result = intakeEvidence({
    subject: "Job application",
    resume:
      "Fictional Test Person\nCONTACT\n09123456789\nexample@example.invalid\nEDUCATION\nhigh school graduate\nJOB EXPERIENCE\n2024-2025\nBarista at Example Coffee\nAssisted customers and prepared drinks.\nSKILLS\ncustomer service\ntime management\nCERTIFICATIONS\nfood safety training",
  });
  assert.match(result.experienceDetails, /Barista at Example Coffee/);
  assert.match(result.skills, /Customer Service/);
  assert.match(result.skills, /Time Management/);
  assert.match(result.certifications, /Food Safety Training/);
  assert.equal(result.sources.skills, "Resume");
});
test("resume filename can recover an uncertain name and subject role omits the sender suffix", () => {
  const result = intakeEvidence({
    subject: "Application for Junior Data Analyst - Fictional Person",
    filename: "Fictional Person - PDF Resume.pdf",
    from: "<fixture@example.invalid>",
  });
  assert.equal(result.name, "Fictional Person");
  assert.equal(result.position, "Junior Data Analyst");
  assert.equal(
    evidenceInformation(result).fields.name.source,
    "Attachment filename",
  );
  assert.equal(evidenceInformation(result).fields.name.confidence, "Uncertain");
  const application = {
    applicant: { name: "Name needs verification" },
    position: "Junior Data Analyst - Fictional Person",
    information: { fields: {}, conflicts: [] },
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, result);
  assert.equal(application.applicant.name, "Fictional Person");
  assert.equal(application.position, "Junior Data Analyst");
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
