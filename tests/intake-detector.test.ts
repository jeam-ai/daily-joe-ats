import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationSearchQuery,
  detectApplicationEmail,
  GMAIL_APPLICATION_QUERY,
} from "../lib/intake-detector";

const base = { subject: "", body: "", filenames: [] as string[] };
test("the shipped label filter upgrades to label-free search and deliberate filters survive", () => {
  assert.equal(
    applicationSearchQuery(
      'label:"HR - Applications" -in:spam -in:trash -in:sent',
    ),
    GMAIL_APPLICATION_QUERY,
  );
  assert.equal(applicationSearchQuery(""), GMAIL_APPLICATION_QUERY);
  assert.equal(
    applicationSearchQuery('from:agency@example.com label:"Agency"'),
    'from:agency@example.com label:"Agency"',
  );
  assert.ok(!GMAIL_APPLICATION_QUERY.includes("label:"));
});
test("unlabelled applications use subject, sender intent or verified resume contents", () => {
  for (const details of [
    { filenames: ["Juan_CV.pdf"] },
    { subject: "Application" },
    { subject: "Application for Barista" },
    { body: "I would like to apply for Barista." },
    { body: "I am writing to apply for the Barista position." },
    { body: "I would like to submit my application for Barista." },
    { body: "Gusto ko mag-apply sa inyo." },
    {
      filenames: ["John.txt"],
      resumeText:
        "EDUCATION\nHigh school\nWORK EXPERIENCE\nCafe\nSKILLS\nCustomer service",
    },
  ])
    assert.equal(
      detectApplicationEmail({ ...base, ...details }).decision,
      "application",
    );
  assert.equal(
    detectApplicationEmail({ ...base, filenames: ["John.txt"] }).decision,
    "inspect-document",
  );
});
test("business documents, mail lists, automatic messages and non-resume attachments stay out", () => {
  for (const details of [
    { subject: "Invoice", filenames: ["invoice.pdf"] },
    {
      subject: "Application for payment",
      body: "Invoice attached",
      filenames: ["payment.pdf"],
    },
    {
      subject: "Application for Barista",
      headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
    },
    {
      subject: "Resume service newsletter",
      headers: [{ name: "List-ID", value: "newsletter" }],
    },
    { subject: "Automatic reply: Application for Barista" },
    { filenames: ["resume.pdf"], labelIds: ["SPAM"] },
    { filenames: ["resume.pdf"], labelIds: ["SENT"] },
    {
      filenames: ["contract.txt"],
      resumeText: "Service contract\nTerms and conditions",
    },
  ])
    assert.notEqual(
      detectApplicationEmail({ ...base, ...details }).decision,
      "application",
    );
});
test("quoted applications in replies stay thread activity while a newly submitted CV is eligible", () => {
  const reply = {
    ...base,
    subject: "Re: Application for Barista",
    body: "Thank you.\nOn Monday HR wrote:\nI am applying for Barista",
    headers: [{ name: "In-Reply-To", value: "<original>" }],
  };
  assert.equal(detectApplicationEmail(reply).decision, "ignore");
  assert.equal(
    detectApplicationEmail({
      ...reply,
      knownThread: true,
      filenames: ["updated-CV.pdf"],
    }).decision,
    "application",
  );
});
