import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ScreeningCriterion } from "../components/applicant-profile";
import { StatusBadge } from "../components/ui";
test("disconnected Gmail is never styled as connected", () => {
  const html = renderToStaticMarkup(
    createElement(StatusBadge, { status: "Not Connected" }),
  );
  assert.ok(html.includes("badge neutral"));
  assert.ok(!html.includes("badge green"));
});
test("the sign-in page is visible before workspace hydration", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  const login = readFileSync("app/login/page.tsx", "utf8");
  const provider = readFileSync("components/provider.tsx", "utf8");
  assert.ok(!layout.includes("theme-pending"));
  assert.ok(login.includes("Continue with Google"));
  assert.ok(provider.includes('state?.preferences.theme === "dark"'));
  assert.ok(!provider.includes("matchMedia"));
});
test("screening renders the configured requirement and evidence with a text result", () => {
  const html = renderToStaticMarkup(
    createElement(ScreeningCriterion, {
      criterion: {
        id: "c1",
        requirement: "Available for shifts",
        result: "Unclear",
        evidence: "Availability is not stated.",
      },
    }),
  );
  assert.ok(html.includes("Available for shifts"));
  assert.ok(html.includes("Unclear"));
  assert.ok(html.includes("Availability is not stated."));
  assert.ok(html.includes("Evidence:"));
});
test("only deliberate Gmail test API invokes real email sending", () => {
  const callback = readFileSync("app/api/auth/callback/route.ts", "utf8");
  const transition = readFileSync("lib/recruitment.ts", "utf8");
  assert.ok(!callback.includes("sendEmail"));
  assert.ok(!transition.includes("sendEmail"));
  const send = readFileSync("app/api/integrations/gmail/test/route.ts", "utf8");
  for (const boundary of [
    "requireOrigin",
    "requireUser",
    "validateEmailInput",
    "Idempotency-Key",
  ])
    assert.ok(send.includes(boundary));
});
test("credential and token paths are ignored and environment template is blank", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  assert.ok(ignore.includes(".env*"));
  assert.ok(ignore.includes(".data/"));
  const lines = readFileSync(".env.example", "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(lines.every((line) => line.endsWith("=") && !line.split("=")[1]));
});
