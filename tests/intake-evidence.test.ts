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
  assert.equal(
    r.location,
    "Preferred work location was not clearly stated in the submitted application.",
  );
  assert.equal(
    r.position,
    "Applied position was not clearly stated in the submitted application.",
  );
  assert.equal(
    r.name,
    "Applicant name was not clearly stated in the submitted application.",
  );
});
test("email body preferences take priority over a subject when no resume preference exists", () => {
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
  assert.equal(conflict.location, "Santa Rosa, Laguna");
  assert.equal(conflict.sources.location, "Email body");
  assert.equal(conflict.warnings.length, 0);
});
test("email subject and conversational body remain usable when a resume is unavailable", () => {
  const body = intakeEvidence({
    subject: "RESUME FOR JOB APPLICATION",
    body: "Hello po, good day! I'm Jean Mitch Peñaflor po, applying for barista. I am willing to learn.",
  });
  assert.equal(body.name, "Jean Mitch Peñaflor");
  assert.equal(body.position, "Barista");
  const subject = intakeEvidence({ subject: "Jennifer Mendoza - Resume" });
  assert.equal(subject.name, "Jennifer Mendoza");
});
test("resume evidence wins before email fallback and richer section headings are recognized", () => {
  const resumeFirst = intakeEvidence({
    subject: "Application for Barista - Naga City",
    body: "Phone: 0999 222 3333\nSkills: Sales\nCertifications: First aid training",
    resume:
      "PHONE: 0917 123 4567\nCORE SKILLS\nCash handling\nCustomer service\nLICENSES\nFood Safety Training",
  });
  assert.equal(resumeFirst.phone, "0917 123 4567");
  assert.match(resumeFirst.skills, /Cash Handling/i);
  assert.doesNotMatch(resumeFirst.skills, /Sales/i);
  assert.match(resumeFirst.certifications, /Food Safety Training/i);
  assert.equal(resumeFirst.sources.phone, "Resume");
  assert.equal(resumeFirst.sources.skills, "Resume");
  assert.equal(resumeFirst.sources.certifications, "Resume");

  const resumePreference = intakeEvidence({
    subject: "Application for Cashier - Santa Rosa, Laguna",
    body: "I am applying for Cashier at Santa Rosa, Laguna.",
    resume: "Desired position: Barista\nPreferred branch: Naga City",
  });
  assert.equal(resumePreference.position, "Barista");
  assert.equal(resumePreference.location, "Naga City");
  assert.equal(resumePreference.sources.position, "Resume");
  assert.equal(resumePreference.sources.location, "Resume");

  const emailFallback = intakeEvidence({
    subject: "Kara Example - Resume | Application for Barista, Naga City",
    body: "Availability: immediately available\nTechnical Skills: Cash handling\nLicenses: Food Safety Training",
  });
  assert.equal(emailFallback.position, "Barista");
  assert.equal(emailFallback.location, "Naga City");
  assert.match(emailFallback.availability, /immediately available/i);
  assert.match(emailFallback.skills, /Cash handling/i);
  assert.match(emailFallback.certifications, /Food Safety Training/i);
  assert.equal(emailFallback.sources.skills, "Email body");
});
test("built-in parsing covers every profile field before using email fallback", () => {
  const result = intakeEvidence({
    subject: "Application for Cashier - Santa Rosa, Laguna",
    body: "Availability: Can start immediately.\nApplying as Cashier at Santa Rosa, Laguna.",
    from: "Ana Sender <ana.sender@example.invalid>",
    resume:
      "APPLICANT NAME: Ana Resume Person\nCONTACT DETAILS\nMobile: +63 917 123 4567\nCurrent Residence: Zone 4, Pili, Camarines Sur\nDesired role: Barista\nPreferred branch: Naga City\nEDUCATIONAL BACKGROUND\nBachelor of Science in Hospitality Management\nRELEVANT EXPERIENCE\nBarista — Example Coffee, 2024–2026\nKEY SKILLS\nCash handling\nCustomer service\nCREDENTIALS\nFood Safety Training",
  });
  assert.equal(result.name, "Ana Resume Person");
  assert.equal(result.phone, "+63 917 123 4567");
  assert.match(result.residence, /Zone 4, Pili, Camarines Sur/i);
  assert.equal(result.position, "Barista");
  assert.equal(result.location, "Naga City");
  assert.match(result.education, /Hospitality Management/i);
  assert.match(result.experienceDetails, /Example Coffee/i);
  assert.match(result.skills, /Cash Handling/i);
  assert.match(result.certifications, /Food Safety Training/i);
  assert.match(result.availability, /Can start immediately/i);
  assert.equal(result.sources.phone, "Resume");
  assert.equal(result.sources.residence, "Resume");
  assert.equal(result.sources.position, "Resume");
  assert.equal(result.sources.location, "Resume");
  assert.equal(result.sources.education, "Resume");
  assert.equal(result.sources.experienceDetails, "Resume");
  assert.equal(result.sources.skills, "Resume");
  assert.equal(result.sources.certifications, "Resume");
  assert.equal(result.sources.availability, "Email body");
  assert.equal(result.sources.email, "Gmail sender");
});
test("structured education, key strengths, and a configured residence branch are recovered without AI", () => {
  const result = intakeEvidence({
    subject: "Application for Barista",
    locations: ["Naga City", "Santa Rosa, Laguna"],
    resume:
      "Address: Zone 3, Concepcion Pequena, Naga City\nTERTIARY:\nBicol State College of Applied Sciences and Technology\nNaga City Camarines Sur, Philippines\nBachelor of Technical Teacher Education\nMajor in Food Service Management\n2015- 2019\nSECONDARY:\nSan Pascual National High School\nSan Pascual Burias Masbate\n2012-2015\nKEY STRENGTHS\nAbility to work independently\nGood interpersonal skills\nFlexible and adaptable\nExtensive experience working with multidisciplinary teams",
  });
  assert.equal(result.residenceLocation, "Naga City");
  assert.equal(result.location, "Naga City");
  assert.match(result.education, /Bicol State College/i);
  assert.match(result.education, /Food Service Management/i);
  assert.match(result.education, /2015–2019/);
  assert.match(result.education, /2012–2015/);
  assert.match(result.skills, /Ability to work independently/i);
  assert.match(result.skills, /Good interpersonal skills/i);
  assert.equal(result.sources.skills, "Resume");
  assert.equal(result.sources.assignedBranch, "Residence match");
  assert.equal(result.sources.location, "Residence match");
});
test("an exact configured residence becomes the location fallback and OCR names reject profile labels", () => {
  const result = intakeEvidence({
    subject: "Application for Barista",
    locations: ["Naga City"],
    resume:
      "JUANITO INSERT0 BERNARTE\nNaga City, Philippines\nPERSONAL INFORMATION\nFull Name: Place Of Birth Single\nAddress: Zone 3, Concepcion Pequena, Naga City",
  });
  assert.equal(result.name, "Juanito Inserto Bernarte");
  assert.equal(result.location, "Naga City");
  assert.equal(result.residenceLocation, "Naga City");
});
test("timeline education, unlabeled contact addresses, and qualifications do not bleed into one another", () => {
  const result = intakeEvidence({
    subject: "Application for Barista - General Trias",
    locations: ["General Trias"],
    resume:
      "JUANITO INSERT0 BERNARTE\nCONTACT\n(+63) 915 2257 470\nbernartejuanito24@gmail.com\nblk 14 lot 21 asturias st. maravilla subd brgy. general trias cavite\nEDUCATION\nCollege\nLYCEUM OF THE PHILIPPINES\n2016 - 2018\nBachelor Of Arts in Multimedia Arts\nDE LASALLE COLLEGE OF SAINT BENILDE\n2011 - 2015\nBachelor Of Arts in Animation\nQUALIFICATIONS\nCustomer Service\nHandling Customer Inquiries\nTrainings Attended\nCareer Guidance and Employment Coaching Training Sessions\nEXPERIENCE\nProcessed cash, card, and digital transactions accurately using POS systems.",
  });
  assert.match(result.residence, /Blk\. 14 Lot 21 Asturias St\./);
  assert.doesNotMatch(result.residence, /Processed cash/i);
  assert.match(result.education, /Lyceum of the Philippines/i);
  assert.match(result.education, /2016–2018/);
  assert.match(result.education, /De Lasalle College of Saint Benilde/i);
  assert.match(result.education, /2011–2015/);
  assert.match(result.skills, /Customer Service/i);
  assert.match(result.skills, /Handling Customer Inquiries/i);
  assert.doesNotMatch(result.skills, /Lyceum|Trainings Attended/i);
  assert.match(result.certifications, /Career Guidance/i);
  assert.match(result.experienceDetails, /Processed cash/i);
});
test("email-body labels fill all profile fields when no readable resume exists", () => {
  const result = intakeEvidence({
    subject: "Mia Example - Job Application",
    from: "Mia Example <mia@example.invalid>",
    body: "Applicant Name: Mia Example\nPhone: 0917-555-1234\nResidence: Barangay San Jose, Naga City, Camarines Sur\nI am applying as Barista at Naga City branch.\nEducational Attainment: Senior High School Graduate\nAvailability: Flexible schedule, including weekends\nEMPLOYMENT\nService Crew — Example Restaurant, 2023–2025\nTECHNICAL SKILLS\nPoint-of-sale operation\nCustomer service\nLICENSES\nFirst Aid Training",
  });
  assert.equal(result.name, "Mia Example");
  assert.equal(result.phone, "0917-555-1234");
  assert.match(result.residence, /Barangay San Jose/i);
  assert.equal(result.position, "Barista");
  assert.equal(result.location, "Naga City");
  assert.match(result.education, /Senior High School Graduate/i);
  assert.match(result.availability, /Flexible schedule/i);
  assert.match(result.experienceDetails, /Example Restaurant/i);
  assert.match(result.skills, /Point-Of-Sale Operation/i);
  assert.match(result.certifications, /First Aid Training/i);
  for (const field of [
    "phone",
    "residence",
    "position",
    "location",
    "education",
    "availability",
    "experienceDetails",
    "skills",
    "certifications",
  ])
    assert.equal(result.sources[field], "Email body", field);
});
