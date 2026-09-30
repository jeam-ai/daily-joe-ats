import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord } from "../../lib/server/database";
import { getState } from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";
import { withStore } from "../../lib/server/store";
import { syncIntake } from "../../lib/google/gmail/sync";
import { unseal } from "../../lib/auth/security";
import { previewImport } from "../../lib/google/gmail/intake";

for (const key of [
  "DATABASE_URL",
  "DATABASE_POOL_URL",
  "AIVEN_DATABASE_URL",
  "VERCEL",
  "OPENAI_API_KEY",
  "GOOGLE_SHEETS_ID",
])
  delete process.env[key];
Object.assign(process.env, {
  PERSISTENCE_PROVIDER: "local",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});

process.chdir(mkdtempSync(path.join(tmpdir(), "djc-label-free-intake-")));

test("automatic intake detects labelled and unlabelled submissions together, verifies neutral filenames and excludes unrelated mail", async () => {
  const initial = initialState();
  initial.intakeQuery = 'label:"HR - Applications" -in:spam -in:trash -in:sent';
  await transaction((tx) => putRecord(tx, "workspace", "main", initial));
  await withStore((s) => {
    s.officialConnection = {
      email: "careers@example.invalid",
      accessToken: "fixture",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 600000,
      connectedAt: new Date().toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
  });
  const encode = (text: string) => Buffer.from(text).toString("base64url");
  const attachment = (filename: string, text: string) => ({
    filename,
    mimeType: "text/plain",
    body: { data: encode(text) },
  });
  const fixtures = [
    {
      id: "labelled",
      subject: "Application for Barista",
      parts: [
        attachment(
          "resume.txt",
          "Fictional QA resume with cafe work experience.",
        ),
      ],
      labels: ["Label_old_hr"],
    },
    {
      id: "unlabelled",
      subject: "",
      parts: [
        attachment(
          "Juan_CV.txt",
          "Fictional Juan resume with cafe work experience.",
        ),
      ],
    },
    {
      id: "neutral",
      subject: "",
      parts: [
        attachment(
          "Maria.txt",
          "MARIA QA\nEDUCATION\nHigh school graduate\nWORK EXPERIENCE\nCafe staff\nSKILLS\nCustomer service",
        ),
      ],
    },
    {
      id: "body-only",
      subject: "Hello",
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: encode("I would like to apply for Barista at your company."),
          },
        },
      ],
    },
    {
      id: "invoice",
      subject: "Invoice",
      parts: [attachment("invoice.txt", "Monthly service invoice")],
    },
    {
      id: "contract",
      subject: "",
      parts: [
        attachment("agreement.txt", "Service contract terms and conditions"),
      ],
    },
    {
      id: "autoreply",
      subject: "Application for Barista",
      headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
      parts: [],
    },
    {
      id: "newsletter",
      subject: "Resume service",
      headers: [{ name: "List-Id", value: "newsletters" }],
      parts: [],
    },
    {
      id: "reply",
      subject: "Re: Application for Barista",
      headers: [{ name: "In-Reply-To", value: "<previous>" }],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: encode(
              "Thank you.\nOn Monday HR wrote:\nI am applying for Barista",
            ),
          },
        },
      ],
    },
  ];
  const original = globalThis.fetch;
  const searches: string[] = [];
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      writes++;
      throw Error("Gmail writes are prohibited");
    }
    if (url.endsWith("/profile"))
      return Response.json({ emailAddress: "careers@example.invalid" });
    if (url.includes("messages?")) {
      const query = new URL(url).searchParams.get("q")!;
      searches.push(query);
      assert.ok(!query.includes("label:"));
      return Response.json({ messages: fixtures.map(({ id }) => ({ id })) });
    }
    const id = url.match(/messages\/([^/?]+)/)?.[1];
    const fixture = fixtures.find((m) => m.id === id);
    assert.ok(fixture, `Unexpected Gmail request: ${url}`);
    return Response.json({
      id,
      threadId: `thread-${id}`,
      internalDate: String(Date.now()),
      labelIds: fixture.labels || ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: `Fictional QA ${id} <${id}@example.invalid>` },
          { name: "Subject", value: fixture.subject },
          ...(fixture.headers || []),
        ],
        parts: fixture.parts,
      },
    });
  };
  try {
    await syncIntake(undefined, true);
    let state = await transaction(getState);
    assert.deepEqual(state.applications.map((a) => a.gmailMessageId).sort(), [
      "body-only",
      "labelled",
      "neutral",
      "unlabelled",
    ]);
    assert.ok(!state.intakeQuery?.includes("label:"));
    const resumeId = state.applications.find(
      (a) => a.gmailMessageId === "neutral",
    )?.resumeId;
    assert.ok(resumeId);
    const resume = await transaction(
      async (tx) =>
        (
          await tx.query("SELECT extracted_text FROM resumes WHERE id=$1", [
            resumeId,
          ])
        )[0],
    );
    assert.ok(
      unseal<string>(
        String(resume.extracted_text),
        process.env.TOKEN_ENCRYPTION_KEY!,
      ).includes("EDUCATION"),
    );
    await syncIntake(undefined, true);
    state = await transaction(getState);
    assert.equal(
      state.applications.length,
      4,
      "retry must not duplicate applications",
    );
    assert.ok(searches.length > 0);
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("an unreadable attachment without application evidence stays out and remains eligible for the worker's bounded retry", async () => {
  const state = initialState();
  await transaction((tx) => putRecord(tx, "workspace", "main", state));
  await withStore((s) => {
    s.officialConnection = {
      email: "careers@example.invalid",
      accessToken: "fixture",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 600000,
      connectedAt: new Date().toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
  });
  const actor = state.users?.[0];
  assert.ok(actor);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: "unreadable",
      threadId: "thread-unreadable",
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: "From", value: "Fictional QA <unreadable@example.invalid>" },
        ],
        parts: [
          {
            filename: "Maria.txt",
            body: { data: Buffer.from([0, 1, 2]).toString("base64url") },
          },
        ],
      },
    });
  try {
    const preview = await previewImport(actor, {
      ids: ["unreadable"],
      automatic: true,
    });
    assert.equal(preview.rows.length, 0);
    assert.ok(
      preview.issues.some((issue) =>
        /Failed to read|time limit/.test(issue.reason),
      ),
    );
    assert.equal((await transaction(getState)).applications.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
