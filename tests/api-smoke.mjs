// Run against the local dev server. No credentials are supplied, so every send
// request must fail before it can reach Gmail. This never makes a real send.
import assert from "node:assert/strict";
const base = "http://localhost:3000";
for (const path of [
  "/",
  "/applications",
  "/applications/DJ-1041",
  "/hiring-needs",
  "/talent-pool",
  "/reports",
  "/notifications",
  "/settings/integrations",
  "/settings/qualifications",
  "/settings/requirements",
  "/settings/email-templates",
  "/settings/users",
  "/settings/preferences",
  "/login",
]) {
  const response = await fetch(base + path, { redirect: "manual" });
  assert.equal(response.status, path === "/login" ? 200 : 307, path);
  if (path !== "/login")
    assert.ok(response.headers.get("location").endsWith("/login"));
  console.log(`PASS ${path}`);
}
const status = await (await fetch(base + "/api/integrations/gmail")).json();
assert.equal(status.authenticated, false);
assert.equal(status.connected, false);
const noSession = await fetch(base + "/api/integrations/gmail/test", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(noSession.status, 401);
const crossOrigin = await fetch(base + "/api/integrations/gmail/test", {
  method: "POST",
  headers: {
    Origin: "https://untrusted.example",
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(crossOrigin.status, 403);
const noDisconnect = await fetch(base + "/api/integrations/gmail", {
  method: "DELETE",
  headers: { Origin: base },
});
assert.equal(noDisconnect.status, 401);
const callback = await fetch(
  base + "/api/auth/callback?state=invalid&code=fake",
  { redirect: "manual" },
);
assert.equal(callback.status, 307);
assert.ok(callback.headers.get("location").endsWith("/login?error=state"));
const oauth = await fetch(base + "/api/auth/google", { redirect: "manual" });
assert.equal(oauth.status, 307);
const authUrl = new URL(oauth.headers.get("location"));
assert.equal(authUrl.hostname, "accounts.google.com");
assert.equal(authUrl.searchParams.get("scope"), "openid email profile");
assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
assert.ok(oauth.headers.get("set-cookie").includes("HttpOnly"));
console.log(
  "PASS unauthorized send, cross-origin send, disconnect, invalid OAuth state, and least-privilege login",
);

for (const path of [
  "/api/workspace",
  "/api/tracker",
  "/api/resumes/not-authorized",
]) {
  assert.equal((await fetch(base + path)).status, 401);
}
for (const path of [
  "/api/intake",
  "/api/communications",
  "/api/integrations/sheets",
]) {
  assert.equal(
    (
      await fetch(base + path, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
}
console.log("PASS soft-launch API access boundaries");
