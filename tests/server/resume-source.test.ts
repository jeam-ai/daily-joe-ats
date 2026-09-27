import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadResumeBytes } from "../../lib/server/resume-source";

const bytes = Buffer.from(
  "Fictional applicant resume for source-reference tests.",
);
const row = {
  content: "",
  filename: "resume.txt",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test("deferred resume is retrieved from Gmail by reference without storing a second copy", async () => {
  const requested: string[] = [];
  const loaded = await loadResumeBytes(
    row,
    {
      provider: "gmail",
      gmail_message_id: "message-id",
      gmail_attachment_id: "attachment-id",
    },
    {
      token: async () => "test-token",
      fetchGmail: async (_token, path) => {
        requested.push(path);
        return { data: bytes.toString("base64url") };
      },
    },
  );
  assert.deepEqual(loaded, bytes);
  assert.deepEqual(requested, [
    "messages/message-id/attachments/attachment-id",
  ]);
  assert.equal(row.content, "");
});

test("inline Gmail resume is resolved and a changed attachment is rejected", async () => {
  const source = { provider: "gmail", gmail_message_id: "message-id" };
  const dependencies = {
    token: async () => "test-token",
    fetchGmail: async () => ({
      payload: {
        parts: [
          {
            filename: "resume.txt",
            body: { data: bytes.toString("base64url") },
          },
        ],
      },
    }),
  };
  assert.deepEqual(await loadResumeBytes(row, source, dependencies), bytes);
  await assert.rejects(
    loadResumeBytes(row, source, {
      ...dependencies,
      fetchGmail: async () => ({
        payload: {
          filename: "resume.txt",
          body: { data: Buffer.from("different").toString("base64url") },
        },
      }),
    }),
    /no applicant information was changed/i,
  );
});
