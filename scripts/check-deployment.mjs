// Run inside a fresh router container. Uses a loopback fixture, never a real account.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

const base = "http://127.0.0.1:20128";
const report = { startedAt: new Date().toISOString(), realAccountUsed: false, checks: [] };
let calls = 0;
const fixture = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString());
  calls++;
  const common = { id: "chatcmpl-deployment-fixture", created: 1, model: "gpt-6-luna" };
  const usage = { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 };
  if (request.stream) {
    res.setHeader("content-type", "text/event-stream");
    const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "DOCKER_FIXTURE_OK" }, finish_reason: null }] });
    event({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "DOCKER_FIXTURE_OK" }, finish_reason: "stop" }], usage }));
  }
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
let admin, connectionId, keyId;
try {
  assert.equal((await fetch(base + "/api/health")).status, 200);
  const protectedRoute = await fetch(base + "/api/providers", { redirect: "manual" });
  assert.ok([401, 403, 307].includes(protectedRoute.status));
  const noKey = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chr/gpt-6-luna", messages: [] }) });
  assert.equal(noKey.status, 401);
  report.checks.push({ name: "health-and-auth-guards", passed: true });

  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ password: process.env.INITIAL_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  admin = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", origin: base, cookie }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    return { status: response.status, data: await response.json() };
  };
  report.checks.push({ name: "dashboard-login", passed: true });

  const realBackend = await admin("/api/providers/validate", { provider: "ch-relay", apiKey: "deployment-invalid-token" });
  assert.equal(realBackend.status, 200);
  assert.equal(realBackend.data.valid, false);
  assert.match(realBackend.data.error, /401/);
  report.checks.push({ name: "router-to-real-relay-private-network", passed: true, relayStatus: 401, reason: "No account configured" });

  const connection = await admin("/api/providers", { provider: "ch-relay", name: "Temporary deployment fixture", apiKey: "deployment-fixture-key", testStatus: "active", providerSpecificData: { baseUrl: `http://127.0.0.1:${fixture.address().port}/v1` } });
  connectionId = connection.data.connection?.id;
  assert.equal(connection.status, 201);
  const key = await admin("/api/keys", { name: "Temporary deployment verification" });
  keyId = key.data.id;
  assert.equal(key.status, 201);
  const catalog = await admin(`/api/providers/${connectionId}/models`);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.models.some(model => model.id === "gpt-6-luna"));

  for (const stream of [false, true]) {
    const body = { model: "chr/gpt-6-luna", stream, messages: [{ role: "user", content: "Synthetic Docker transport check" }] };
    if (stream) body.stream_options = { include_usage: true };
    for (const replay of [false, true]) {
      const before = calls;
      const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.data.key}`, "x-relay-cache": "allow", "x-relay-cache-scope": "docker-deployment-check", ...(replay ? { "x-relay-local-only": "1" } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      assert.equal(response.status, 200, `stream=${stream} replay=${replay}`);
      assert.match(text, /DOCKER_FIXTURE_OK/);
      assert.equal(calls - before, replay ? 0 : 1);
      assert.equal(response.headers.get("x-relay-cache"), replay ? "hit" : "miss");
      const usages = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).usage).filter(Boolean) : [JSON.parse(text).usage];
      assert.ok(usages.length > 0);
      for (const usage of usages) assert.equal(usage.total_tokens, replay ? 0 : 13);
      report.checks.push({ name: `${stream ? "sse" : "json"}-${replay ? "cache-replay" : "cold-request"}`, passed: true, fixtureCalls: calls - before });
    }
  }
} finally {
  if (connectionId) assert.equal((await admin(`/api/providers/${connectionId}`, null, "DELETE")).status, 200);
  if (keyId) assert.equal((await admin(`/api/keys/${keyId}`, null, "DELETE")).status, 200);
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
report.temporaryProviderAndKeyRemoved = true;
report.finishedAt = new Date().toISOString();
console.log(JSON.stringify(report, null, 2));
