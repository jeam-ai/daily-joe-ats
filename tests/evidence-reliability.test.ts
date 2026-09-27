import test from "node:test";
import assert from "node:assert/strict";
import { intakeEvidence } from "../lib/intake-evidence";
import {
  qualificationRulesForPosition,
  screenResumeAgainstCriteria,
} from "../lib/screening";
import { ensureRecruitmentConfiguration } from "../lib/server/recruitment-configuration";
import { initialState } from "../lib/server/initial-state";
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
    formalFact("education", "Cavite state university 2023-2024"),
    "Cavite State University 2023–2024",
  );
  assert.equal(
    formalFact("education", "Dasmarinas Integrated High School 2021- 2023"),
    "Dasmarinas Integrated High School 2021–2023",
  );
  assert.equal(
    formalFact(
      "experienceDetails",
      "work experience in the social welfare field",
    ),
    "Work experience in the social welfare field",
  );
  assert.equal(
    formalFact(
      "residence",
      "blk 14 lot 21 asturias st. maravilla subd brgy. general trias cavite",
    ),
    "Blk. 14 Lot 21 Asturias St. Maravilla Subd. Brgy. General Trias Cavite",
  );
  assert.equal(
    formalName("LUNA, VANESSA, FRANCISCO"),
    "Vanessa Francisco Luna",
  );
});
test("a configured location in a residence auto-assigns only an empty branch", () => {
  const evidence = intakeEvidence({
    subject: "Application for Barista",
    locations: ["Naga City", "Santa Rosa, Laguna"],
    resume:
      "Address: Zone 3, Concepcion Pequena, Naga City\nKEY STRENGTHS\nCustomer service",
  });
  const application = {
    applicant: { name: "Fictional Applicant", location: "Not verified" },
    assignedBranch: "",
    information: { fields: {}, conflicts: [] },
    position: "Barista",
    location:
      "Preferred work location was not clearly stated in the submitted application.",
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, evidence);
  assert.equal(application.assignedBranch, "Naga City");
  assert.equal(
    application.information?.fields.assignedBranch?.source,
    "Residence match",
  );
  assert.equal(application.location, "Naga City");
  application.assignedBranch = "Santa Rosa, Laguna";
  applyRecoveredResumeEvidence(application, evidence);
  assert.equal(application.assignedBranch, "Santa Rosa, Laguna");
  const santaRosa = intakeEvidence({
    subject: "Application for Barista",
    locations: ["Naga City", "Santa Rosa, Laguna"],
    resume: "Residence: Barangay Balibago, Santa Rosa, Laguna",
  });
  assert.equal(santaRosa.residenceLocation, "Santa Rosa, Laguna");
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
test("skills and competencies plus a wrapped postal address are recovered without a false first-name conflict", () => {
  const result = intakeEvidence({
    subject: "Barista application - Naga City",
    from: "Fictional <fixture@example.invalid>",
    resume:
      "FICTIONAL TEST PERSON\nAddress: 443 Zone 4, Fictional Barangay,\nCamarines Sur, Philippines\nContact Number: 09123456789\nEXPERIENCE\nGraphic Designer\nExample Company\n2024-Present\nSKILLS AND COMPETENCIES\n• Good communication skills\n• Basic accounting and reporting\nEDUCATION\n2022-Present - COLLEGE\nExample University",
  });
  assert.equal(
    result.residence,
    "443 Zone 4, Fictional Barangay, Camarines Sur, Philippines",
  );
  assert.match(result.skills, /Good Communication Skills/i);
  assert.match(result.skills, /Basic Accounting And Reporting/i);
  assert.match(result.experienceDetails, /Graphic Designer/i);
  assert.doesNotMatch(result.experienceDetails, /Good communication/i);
  assert.equal(result.warnings.length, 0);
  const application = {
    applicant: {
      name: "Fictional Test Person",
      location: "443 Zone 4, Fictional Barangay,",
      skills: "",
    },
    information: {
      fields: {
        residence: {
          source: "Resume",
          confidence: "Confident",
          evidence: "Original address line",
        },
      },
      conflicts: [],
    },
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, result);
  assert.equal(application.applicant.location, result.residence);
  assert.ok(application.applicant.skills);
});
test("General Trias in a Gmail subject is a preferred branch, not part of the job title", () => {
  for (const subject of [
    "Application for Barista - General Trias",
    "Application for Barista General Trias",
    "Barista application — Gen. Tri",
  ]) {
    const result = intakeEvidence({
      subject,
      body: "I would like to apply for this vacancy.",
      locations: ["Gen. Tri"],
      positions: ["Barista"],
    });
    assert.equal(result.position, "Barista", subject);
    assert.equal(result.location, "General Trias", subject);
    assert.equal(result.sources.location, "Email subject", subject);
  }
  const corrected = {
    applicant: { name: "Fictional Person", location: "Not verified" },
    position: "Barista General Trias",
    location:
      "Preferred work location was not clearly stated in the submitted application.",
    information: {
      fields: {
        position: {
          source: "Email subject",
          evidence: "Application for Barista General Trias",
          confidence: "Confident",
        },
      },
      conflicts: [],
    },
  } as unknown as Application;
  applyRecoveredResumeEvidence(
    corrected,
    intakeEvidence({ subject: "Application for Barista General Trias" }),
  );
  assert.equal(corrected.position, "Barista");
  assert.equal(corrected.location, "General Trias");
});
test("a plain Experience heading preserves separate job entries and stops at Skills", () => {
  const result = intakeEvidence({
    subject: "Barista application - General Trias",
    resume:
      "FICTIONAL TEST PERSON\nExperience\nHIGH LANDS EXAMPLE (ON CALL) 2025\nWorked as an on-call table setter and waiter during events.\nSINANGAG EXAMPLE 2024-2025\nCook\nSkills\nFood preparation and basic cooking",
  });
  assert.match(result.experienceDetails, /High lands example/i);
  assert.match(result.experienceDetails, /On-call table setter/i);
  assert.match(result.experienceDetails, /Sinangag example/i);
  assert.match(result.experienceDetails, /Cook/i);
  assert.doesNotMatch(result.experienceDetails, /Food preparation/i);
});
test("certificate/training is separate from Education and repairs unverified saved fields", () => {
  const result = intakeEvidence({
    subject: "Barista application - General Trias",
    resume:
      "FICTIONAL TEST PERSON\nEDUCATION\nCavite State University 2023-2024\nDasmarinas Integrated High School 2021-2023\nCERTIFICATE/TRAINING\nNCII – COOKERY 2023\nNCII – FOOD AND BEVERAGE SERVICES 2023\nSKILLS\nFood preparation",
  });
  assert.match(result.education, /Cavite State University/);
  assert.doesNotMatch(result.education, /Cookery|Beverage Services/i);
  assert.match(result.certifications, /NCII.*Cookery/i);
  assert.match(result.certifications, /NCII.*Food And Beverage Services/i);
  assert.equal(result.sources.certifications, "Resume");
  const application = {
    applicant: {
      name: "Fictional Test Person",
      education:
        "Cavite State University 2023-2024 · Dasmarinas Integrated High School 2021-2023 · Ncii – Cookery 2023 · Ncii – Food And Beverage Services 2023",
      certifications: "",
    },
    information: {
      fields: {
        education: {
          source: "Resume",
          evidence: "Old mixed education evidence",
          confidence: "Confident",
        },
      },
      conflicts: [],
    },
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, result);
  assert.doesNotMatch(application.applicant.education || "", /Cookery/);
  assert.match(application.applicant.certifications || "", /NCII.*Cookery/i);
});
test("stored parser mistakes are replaced by richer resume evidence without touching HR fields", () => {
  const corrected = intakeEvidence({
    subject: "Application for Barista",
    resume:
      "CONTACT\nblk 14 lot 21 asturias st. maravilla subd brgy. general trias cavite\nEDUCATION\nCollege\nLyceum of the Philippines\n2016-2018\nBachelor of Arts in Multimedia Arts\nSKILLS\nCustomer service\nHandling customer inquiries\nCERTIFICATIONS\nCareer Guidance Training Session",
  });
  const application = {
    applicant: {
      name: "Fictional Applicant",
      location:
        "Processed cash, card, and digital transactions accurately using POS systems.",
      education: "Bachelor of Arts in · Bachelor of Arts in",
      skills: "Carmona National High School · Academic Track: HUMSS",
      certifications: "Trainings Attended",
    },
    information: {
      fields: {
        residence: { source: "Resume", confidence: "Confident" },
        education: { source: "Resume", confidence: "Confident" },
        skills: { source: "Resume", confidence: "Confident" },
        certifications: { source: "Resume", confidence: "Confident" },
      },
      conflicts: [],
    },
  } as unknown as Application;
  applyRecoveredResumeEvidence(application, corrected);
  assert.match(application.applicant.location || "", /Blk\. 14 Lot 21/i);
  assert.match(application.applicant.education || "", /Lyceum/i);
  assert.match(application.applicant.skills || "", /Customer service/i);
  assert.match(application.applicant.certifications || "", /Career Guidance/i);
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
test("configured vacancies can identify explicitly submitted branch and specific role", () => {
  const result = intakeEvidence({
    subject: "Application for Area Supervisor - Daet & Sipocot",
    from: "<fixture@example.invalid>",
    positions: ["Area Supervisor", "Supervisor"],
    locations: ["Daet & Sipocot"],
  });
  assert.equal(result.position, "Area Supervisor");
  assert.equal(result.location, "Daet & Sipocot");
  assert.equal(result.sources.location, "Email subject");
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
test("qualification checks accept direct equivalent resume wording without inventing evidence", () => {
  const results = screenResumeAgainstCriteria(
    "Senior High School graduate\nProcessed cash transactions accurately\nService Crew assisting customers",
    [
      {
        id: "school",
        label: "High school graduate or equivalent",
        kind: "Minimum",
        absenceFails: false,
      },
      {
        id: "cash",
        label: "Cash handling",
        kind: "Minimum",
        absenceFails: false,
      },
      {
        id: "service",
        label: "Customer service experience",
        kind: "Minimum",
        absenceFails: false,
      },
    ],
  );
  assert.deepEqual(
    results.map((result) => result.result),
    ["Met", "Met", "Met"],
  );
});
test("qualification screening resolves branch-suffixed roles and uses adjacent resume evidence", () => {
  const templateRules = [
    {
      id: "barista-years",
      label: "Minimum of one year of barista experience",
      kind: "Minimum" as const,
      absenceFails: false,
    },
    {
      id: "cashier",
      label: "Cash handling or POS experience",
      kind: "Minimum" as const,
      absenceFails: false,
    },
  ];
  const rules = qualificationRulesForPosition(
    "Barista - SM San Pedro Branch",
    [],
    [{ position: "Barista", rules: templateRules }],
  );
  assert.equal(rules.length, 2);
  const results = screenResumeAgainstCriteria(
    "Coffee shop Barista\n2019 - 2021\nUsed POS systems and processed card and cash transactions.",
    rules,
  );
  assert.deepEqual(
    results.map((result) => result.result),
    ["Met", "Met"],
  );
});
test("minor extraction warnings do not suppress readable resume screening", () => {
  const result = screenResumeAgainstCriteria(
    "Service Crew assisting customers and handling customer inquiries.",
    [
      {
        id: "service",
        label: "Customer service experience",
        kind: "Minimum",
        absenceFails: false,
      },
    ],
    true,
  )[0];
  assert.equal(result.result, "Met");
  assert.match(result.evidence, /Equivalent resume evidence/);
});
test("missing baseline templates are repaired before applicant evidence is screened", () => {
  const state = initialState();
  state.qualifications = state.qualifications.filter(
    (template) => template.position !== "Barista",
  );
  state.locations = [];
  state.hiringNeeds.push({
    id: "real-need",
    position: "Barista",
    location: "General Trias, Cavite",
    status: "Open",
    slots: 1,
    filled: 0,
    urgency: "Medium",
    targetDate: "",
    qualifications: "",
    questions: "",
  });
  assert.ok(ensureRecruitmentConfiguration(state) >= 3);
  const barista = state.qualifications.find(
    (template) => template.position === "Barista",
  );
  assert.equal(barista?.rules?.length, 4);
  assert.ok(state.locations.some((location) => location.name === "General Trias, Cavite"));
});
