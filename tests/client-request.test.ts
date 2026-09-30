import test from "node:test";
import assert from "node:assert/strict";
import { clientFetch, requestJson, RequestError } from "../lib/client-request";

test("timekeeping deadlines cover server processing while progress checks stay short", async (t) => {
  const durations: number[] = [];
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    durations.push(duration);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  for (const url of [
    "/api/timekeeping",
    "/api/timekeeping?batch=fixture",
    "/api/timekeeping?job=fixture",
    "/api/workspace",
  ])
    await clientFetch(url);
  assert.deepEqual(durations, [180000, 180000, 20000, 60000]);
});
test("timeouts and network interruptions have recoverable statuses without resending mutations", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Fixture timeout", "TimeoutError");
  });
  await assert.rejects(
    clientFetch("/api/timekeeping", { method: "POST" }),
    (error) => error instanceof RequestError && error.status === 408,
  );
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => {
    throw new TypeError("Fixture network failure");
  });
  await assert.rejects(
    clientFetch("/api/timekeeping?job=fixture"),
    (error) => error instanceof RequestError && error.status === 0,
  );
});
test("JSON requests preserve HTTP errors for safe progress recovery", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "Fixture interrupted" }), {
        status: 503,
      }),
  );
  await assert.rejects(
    requestJson("/api/timekeeping?job=fixture"),
    (error) =>
      error instanceof RequestError &&
      error.status === 503 &&
      error.message === "Fixture interrupted",
  );
});
