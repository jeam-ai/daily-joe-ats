import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord, readRecord } from "../../lib/server/database";
import {
  getState,
  saveState,
  updateState,
  publicState,
} from "../../lib/server/repository";
import { initialState } from "../../lib/server/initial-state";
import { withStore } from "../../lib/server/store";
import { seal } from "../../lib/auth/security";
import {
  confirmImport,
  previewImport,
  type PreviewRow,
} from "../../lib/google/gmail/intake";
import type { AppState, User } from "../../types";

process.env.GOOGLE_ALLOWED_EMAIL = "admin@example.com";
process.env.OFFICIAL_CAREERS_EMAIL = "careers@example.com";
process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_CLIENT_SECRET = "test";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/callback";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.SESSION_SECRET = "s".repeat(32);
process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
process.chdir(mkdtempSync(path.join(tmpdir(), "daily-joe-tests-")));
const user: User = {
  id: "admin@example.com",
  email: "admin@example.com",
  name: "Test Admin",
  role: "Admin",
  title: "HR Associate",
  active: true,
};
async function reset() {
  const s = initialState();
  // Boundary tests deliberately exercise the legacy ten-record gate.
  s.importLimit = 10;
  s.importValidated = false;
  s.hiringNeeds = [
    {
      id: "need",
      position: "Barista",
      location: "Naga City",
      slots: 10,
      filled: 0,
      urgency: "High",
      targetDate: "2026-12-31",
      status: "Open",
      qualifications: "",
      questions: "",
      criteria: [
        {
          id: "criterion",
          label: "HR configured requirement",
          kind: "Minimum",
          absenceFails: false,
        },
      ],
    },
  ];
  await transaction((tx) => putRecord(tx, "workspace", "main", s));
  return s;
}
function row(i: number): PreviewRow {
  return {
    messageId: `message-${i}`,
    threadId: `thread-${i}`,
    email: `candidate-${i}@example.com`,
    name: `Test Candidate ${i}`,
    receivedAt: new Date(Date.now() - i * 60000).toISOString(),
    filename: "resume.txt",
    mime: "text/plain",
    hash: `hash-${i}`,
    data: Buffer.from("Test resume").toString("base64"),
    text: "Test resume",
    subject: "Application",
    rfcId: `<message-${i}@example.com>`,
  };
}
async function preview(rows: PreviewRow[]) {
  const id = crypto.randomUUID();
  await transaction((tx) =>
    putRecord(
      tx,
      "import_previews",
      id,
      seal(
        { actor: user.email, expiresAt: Date.now() + 60000, rows, issues: [] },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    ),
  );
  return id;
}
test("transactional soft-launch repository and intake boundaries", async (t) => {
  await t.test(
    "real workspace starts empty and durable saves survive new reads",
    async () => {
      await reset();
      let s = await publicState(user);
      assert.equal(s.applications.length, 0);
      s.preferences.compact = true;
      s = await updateState(s, user, false);
      assert.equal((await publicState(user)).preferences.compact, true);
      assert.ok(s.revision! > 0);
    },
  );
  await t.test("stale updates and role escalation are rejected", async () => {
    await reset();
    const s = await publicState(user);
    await updateState(
      { ...s, preferences: { ...s.preferences, compact: true } },
      user,
      false,
    );
    await assert.rejects(updateState(s, user, false), /Another user/);
    const current = await publicState(user);
    await assert.rejects(
      updateState(
        { ...current, intakeQuery: "all" },
        { ...user, role: "Viewer" },
        true,
      ),
      /administrator/,
    );
  });
  await t.test(
    "initial expansion requires actual ten-record validation",
    async () => {
      await reset();
      const s = await publicState(user);
      await assert.rejects(
        updateState(
          { ...s, importLimit: 100, importValidated: true },
          user,
          true,
        ),
        /first 10/,
      );
    },
  );
  await t.test("no import without explicit confirmation", async () => {
    await reset();
    const rows = [row(1)];
    const id = await preview(rows);
    await assert.rejects(
      confirmImport(
        user,
        id,
        [
          {
            messageId: rows[0].messageId,
            name: rows[0].name,
            hiringNeedId: "need",
          },
        ],
        false,
      ),
      /Confirm/,
    );
    assert.equal((await publicState(user)).applications.length, 0);
  });
  await t.test(
    "first batch creates exactly ten records with source metadata and unclear evidence",
    async () => {
      await reset();
      const rows = Array.from({ length: 10 }, (_, i) => row(i + 10));
      const id = await preview(rows);
      const selections = rows.map((r) => ({
        messageId: r.messageId,
        name: r.name,
        hiringNeedId: "need",
      }));
      const result = await confirmImport(user, id, selections, true);
      assert.equal(result.imported, 10);
      const s = await publicState(user);
      assert.equal(s.applications.length, 10);
      assert.equal(s.applications[0].screening.criteria[0].result, "Unclear");
      assert.equal(s.applications[0].appliedAt, rows[0].receivedAt);
      assert.match(s.applications[0].id, /^DJC-\d{4}-\d{5}$/);
      await assert.rejects(
        confirmImport(user, id, selections, true),
        /used or expired/,
      );
      const more = await preview([row(50)]);
      await assert.rejects(
        confirmImport(
          user,
          more,
          [{ messageId: "message-50", name: "Test", hiringNeedId: "need" }],
          true,
        ),
        /limit reached/,
      );
      const tracker = await transaction((tx) =>
        readRecord<{ state: AppState }>(tx, "tracker", "snapshot"),
      );
      assert.equal(tracker?.state.applications.length, 10);
    },
  );
  await t.test(
    "validated admin expansion stays explicit and duplicates remain skipped",
    async () => {
      let s = await publicState(user);
      await assert.rejects(
        updateState(
          { ...s, importLimit: 100, importValidated: true },
          user,
          false,
        ),
        /confirm expansion/,
      );
      s = await updateState(
        { ...s, importLimit: 100, importValidated: true },
        user,
        true,
      );
      assert.equal(s.importLimit, 100);
      const id = await preview([row(10)]);
      const result = await confirmImport(
        user,
        id,
        [{ messageId: "message-10", name: "Duplicate", hiringNeedId: "need" }],
        true,
      );
      assert.equal(result.imported, 0);
      assert.equal(result.skipped, 1);
    },
  );
  await t.test(
    "preview uses the official mailbox, newest eligible messages, and reports missing resumes",
    async () => {
      await reset();
      await withStore((s) => {
        s.officialConnection = {
          email: "careers@example.com",
          accessToken: "test-only",
          expiresAt: Date.now() + 600000,
          connectedAt: new Date().toISOString(),
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        };
      });
      const original = globalThis.fetch;
      let sendCalls = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/send")) {
          sendCalls++;
          throw Error("Automated sends forbidden");
        }
        if (url.includes("messages?"))
          return Response.json({
            messages: [{ id: "older" }, { id: "newer" }, { id: "missing" }],
          });
        const name = url.includes("newer")
          ? "newer"
          : url.includes("missing")
            ? "missing"
            : "older";
        return Response.json({
          id: name,
          threadId: name,
          internalDate: String(Date.now() - (name === "newer" ? 0 : 60000)),
          payload: {
            headers: [
              { name: "From", value: `Test ${name} <${name}@example.com>` },
              { name: "Subject", value: "Application" },
            ],
            parts:
              name === "missing"
                ? []
                : [
                    {
                      filename: "resume.txt",
                      mimeType: "text/plain",
                      body: {
                        data: Buffer.from(`Resume ${name}`).toString(
                          "base64url",
                        ),
                      },
                    },
                  ],
          },
        });
      };
      try {
        const p = await previewImport(user);
        assert.equal(p.rows[0].messageId, "newer");
        assert.equal(p.rows.length, 2);
        assert.ok(p.issues.some((i) => i.reason.includes("Missing")));
        assert.equal(sendCalls, 0);
      } finally {
        globalThis.fetch = original;
      }
    },
  );
});
