import test from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  validateState,
  seal,
  unseal,
  sessionHash,
} from "../lib/auth/security";
import {
  buildEmailPayload,
  validateEmailInput,
  validEmail,
  DEFAULT_BODY,
  DEFAULT_SUBJECT,
} from "../lib/google/gmail/payload";
import { initializeGoogleClient } from "../lib/google/client";
test("Google client requires complete configuration and initializes without network activity", () => {
  assert.throws(() =>
    initializeGoogleClient({ clientId: "", clientSecret: "", redirectUri: "" }),
  );
  const client = initializeGoogleClient({
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "http://localhost:3000/api/auth/callback",
  });
  assert.ok(client);
  assert.deepEqual(client.credentials, {});
});
test("OAuth state rejects mismatches, missing values, and expired requests", () => {
  const state = createState();
  assert.equal(validateState(state, state, Date.now() + 10000), true);
  assert.equal(validateState(null, state, Date.now() + 10000), false);
  assert.equal(validateState("malicious", state, Date.now() + 10000), false);
  assert.equal(validateState(state, state, Date.now() - 1), false);
  assert.notEqual(state, createState());
});
test("encrypted token storage authenticates ciphertext and never reveals tokens", () => {
  const key = "a".repeat(64);
  const encoded = seal({ refreshToken: "private-token" }, key);
  assert.equal(encoded.includes("private-token"), false);
  assert.deepEqual(unseal(encoded, key), { refreshToken: "private-token" });
  assert.throws(() => unseal(encoded, "b".repeat(64)));
  assert.throws(() => unseal(encoded.slice(0, -6) + "AAAAAA", key));
});
test("session hashes depend on the server secret", () =>
  assert.notEqual(
    sessionHash("session", "secret-a"),
    sessionHash("session", "secret-b"),
  ));
test("recipient validation disallows injection and malformed email", () => {
  assert.ok(validEmail("test+tag@example.com"));
  for (const value of [
    "no-at-symbol",
    "x@y",
    "a@example.com\r\nBcc: victim@example.com",
    "a b@example.com",
  ])
    assert.equal(validEmail(value), false);
});
test("only designated recipient can receive a test and subject headers cannot be injected", () => {
  const safe = {
    to: "test@example.com",
    subject: DEFAULT_SUBJECT,
    body: DEFAULT_BODY,
  };
  assert.deepEqual(validateEmailInput(safe, "test@example.com"), safe);
  assert.throws(() => validateEmailInput(safe));
  assert.throws(() => validateEmailInput(safe, "someone@example.com"));
  assert.throws(() =>
    validateEmailInput(
      { ...safe, subject: "Hello\r\nBcc: x@example.com" },
      safe.to,
    ),
  );
  assert.throws(() => validateEmailInput({ ...safe, body: "" }, safe.to));
  assert.throws(() =>
    validateEmailInput({ ...safe, body: "a".repeat(10001) }, safe.to),
  );
});
test("MIME payload preserves UTF-8 text and uses base64url transport", () => {
  const raw = buildEmailPayload({
    to: "test@example.com",
    subject: DEFAULT_SUBJECT,
    body: DEFAULT_BODY,
  }).raw;
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(raw, "base64url").toString();
  assert.ok(decoded.startsWith("To: test@example.com\r\n"));
  assert.ok(decoded.includes(Buffer.from(DEFAULT_SUBJECT).toString("base64")));
  const encodedBody = decoded.split("\r\n\r\n")[1];
  assert.equal(
    Buffer.from(encodedBody, "base64").toString().replaceAll("\r\n", "\n"),
    DEFAULT_BODY,
  );
});
