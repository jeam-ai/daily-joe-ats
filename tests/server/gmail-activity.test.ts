import assert from "node:assert/strict";
import test from "node:test";
import { matchThreadActivity } from "../../lib/google/gmail/activity";
import type { Application } from "../../types";

const application = {
  id: "DJC-2026-00001",
  gmailMessageId: "initial",
  gmailThreadId: "thread-1",
  appliedAt: "2026-09-26T02:00:00.000Z",
  applicant: { email: "candidate@example.com" },
} as Application;
const message = (id: string, from: string, to: string) => ({
  id,
  threadId: "thread-1",
  internalDate: String(Date.parse("2026-09-27T03:00:00.000Z")),
  payload: {
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      { name: "Subject", value: "Re: Job application" },
    ],
  },
});

test("Gmail replies and auto-replies become distinct thread activity without re-importing the application", () => {
  const incoming = matchThreadActivity(
    message(
      "reply",
      "Candidate <candidate@example.com>",
      "careers@example.com",
    ),
    [application],
    "careers@example.com",
  );
  assert.equal(incoming?.direction, "incoming");
  assert.equal(incoming?.applicationId, application.id);
  const outgoing = matchThreadActivity(
    message(
      "auto",
      "Careers <careers@example.com>",
      "Candidate <candidate@example.com>",
    ),
    [application],
    "careers@example.com",
  );
  assert.equal(outgoing?.direction, "outgoing");
  assert.equal(
    matchThreadActivity(
      message("initial", "candidate@example.com", "careers@example.com"),
      [application],
      "careers@example.com",
    ),
    null,
  );
  assert.equal(
    matchThreadActivity(
      message("unrelated", "other@example.com", "careers@example.com"),
      [application],
      "careers@example.com",
    ),
    null,
  );
});

test("A shared Gmail thread attaches a reply to the latest eligible application", () => {
  const newer = {
    ...application,
    id: "DJC-2026-00002",
    gmailMessageId: "second",
    appliedAt: "2026-09-27T02:00:00.000Z",
  };
  const matched = matchThreadActivity(
    message("reply-2", "candidate@example.com", "careers@example.com"),
    [application, newer],
    "careers@example.com",
  );
  assert.equal(matched?.applicationId, newer.id);
  const original = { ...application, rfcMessageId: "<original@example.com>" };
  const directReply = {
    ...message(
      "reply-to-original",
      "candidate@example.com",
      "careers@example.com",
    ),
    payload: {
      headers: [
        ...message(
          "reply-to-original",
          "candidate@example.com",
          "careers@example.com",
        ).payload.headers,
        { name: "In-Reply-To", value: "<original@example.com>" },
      ],
    },
  };
  assert.equal(
    matchThreadActivity(directReply, [original, newer], "careers@example.com")
      ?.applicationId,
    original.id,
  );
});
