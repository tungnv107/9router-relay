// Run with bun inside the fresh relay container; does not use an account or consume quota.
import assert from "node:assert/strict";
const main = "http://127.0.0.1:11500";
const admin = "http://127.0.0.1:11504";
const checks = [];
for (const [base, route] of [[main, "/healthz"], [admin, "/healthz"], [admin, "/"], [admin, "/chunk-2q8tsrp3.js"], [admin, "/chunk-rgssp4v7.css"]]) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200, route);
  assert.ok((await response.text()).length > 0);
  checks.push({ route, status: response.status });
}
const catalog = await fetch(main + "/v1/models");
// A fresh share server requires a ChatGPT credential even for discovery.
assert.equal(catalog.status, 401);
const policy = await (await fetch(admin + "/api/network-policy", { headers: { "x-ch-relay": "1" } })).json();
assert.equal(policy.enforced, true);
assert.deepEqual(policy.allowedOrigins, ["https://chatgpt.com", "https://auth.openai.com", "https://daily-cloudcode-pa.googleapis.com"]);
assert.equal(policy.antigravity.authentication, "google-oauth-access-token");
assert.equal(policy.vendorServices, false);
const unauth = await fetch(main + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", input: "unauthenticated deployment check" }) });
assert.ok([401, 403].includes(unauth.status), `Expected auth rejection, got ${unauth.status}`);
const google = await fetch(main + "/v1/antigravity/v1internal:generateContent", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(google.status, 401);
assert.equal(google.headers.get("x-relay-upstream-requests"), "0");
console.log(JSON.stringify({ checks, unauthenticatedCatalog: catalog.status, networkPolicy: policy, unauthenticatedInference: unauth.status, unauthenticatedGoogle: google.status, authenticatedInferenceTested: false }, null, 2));
