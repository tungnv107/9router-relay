// Production HTTP smoke test with only a Codex connection, never a ch-relay connection.
// Default: synthetic loopback backend. --live: existing local ChatGPT token + running relay.
// Uses an isolated profile and removes its credential database after shutting down.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = path.join(root, ".scratch");
fs.mkdirSync(scratch, { recursive: true });
const run = fs.mkdtempSync(path.join(scratch, "codex-relay-smoke-"));
const live = process.argv.includes("--live");
const marker = "CODEX_AUTO_RELAY_OK";
const report = { mode: live ? "live-relay" : "http-fixture", startedAt: new Date().toISOString(), productionModified: false, checks: [] };
let app, bridge, browser, posts = 0, stopped = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = async server => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
try {
  let token = "synthetic-codex-oauth-token";
  if (live) {
    const authPath = process.env.CH_RELAY_TEST_AUTH_FILE || path.join(os.homedir(), ".codex", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    token = auth.tokens?.access_token;
    assert.ok(token, "Missing existing local ChatGPT access token");
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.ok(claims.exp * 1000 > Date.now(), "Existing token expired; smoke test does not refresh it");
  }
  bridge = http.createServer(async (req, res) => {
    if (req.method === "POST") posts++;
    if (live) {
      const upstream = http.request({ hostname: "127.0.0.1", port: 11500, path: req.url, method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:11500" } }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.ok(req.url.startsWith("/v1/responses"));
    if (req.url.endsWith("/compact")) {
      assert.equal(body.stream, undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture-state" }] }));
      return;
    }
    const response = { id: "resp-fixture", object: "response", model: body.model, status: "completed",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: marker, annotations: [] }] }],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } };
    res.setHeader("content-type", "text/event-stream");
    for (const event of [
      { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg-fixture", output_index: 0, content_index: 0, delta: marker },
      { type: "response.output_item.done", output_index: 0, item: response.output[0] },
      { type: "response.completed", response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const relayPort = await listen(bridge);
  const socket = net.createServer();
  const port = await listen(socket);
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(20).toString("hex");
  for (const dir of ["data", "AppData/Roaming", "AppData/Local"]) fs.mkdirSync(path.join(run, dir), { recursive: true });
  const env = { ...process.env, DATA_DIR: path.join(run, "data"), INITIAL_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"),
    NEXT_TELEMETRY_DISABLED: "1", ENABLE_REQUEST_LOGS: "false", OBSERVABILITY_ENABLED: "false", NODE_ENV: "production",
    CH_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}/v1`, CH_RELAY_ALLOWED_ORIGINS: "" };
  delete env.CH_RELAY_POLICY_FILE; delete env.CH_RELAY_POLICY_KILL;
  if (process.platform === "win32") Object.assign(env, { USERPROFILE: run, APPDATA: path.join(run, "AppData/Roaming"), LOCALAPPDATA: path.join(run, "AppData/Local") });
  app = spawn(process.execPath, ["custom-server.js", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(app.exitCode, null, "Isolated server exited before readiness");
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) }); await r.text(); if (r.ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert.ok(ready, "Isolated server did not become ready");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await login.text();
  const admin = async (route, body) => {
    const res = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie, origin: base }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(res.ok, `Admin endpoint ${route}: ${res.status}`);
    return res.json();
  };
  const imported = await admin("/api/oauth/codex/import-token", { accessToken: token, name: "Automatic relay verification" });
  assert.equal(imported.connection.provider, "codex");
  const connections = (await admin("/api/providers")).connections;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].provider, "codex");
  assert.equal(connections[0].providerSpecificData?.baseUrl, undefined);
  report.checks.push({ name: "codex-only-no-relay-connection-or-account-url", passed: true });
  const key = await admin("/api/keys", { name: "Isolated smoke client" });
  const request = async (endpoint, body, extra = {}) => {
    const before = posts;
    const res = await fetch(base + endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}`, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    return { res, text, calls: posts - before };
  };
  for (const format of ["chat-json", "responses-stream"]) {
    const body = format === "chat-json"
      ? { model: "cx/gpt-6-luna", stream: false, reasoning_effort: "low", messages: [{ role: "user", content: `Reply exactly ${marker}. No tools.` }] }
      : { model: "codex/gpt-6-luna", stream: true, reasoning: { effort: "low" }, input: `Reply exactly ${marker}. No tools.` };
    const endpoint = format === "chat-json" ? "/v1/chat/completions" : "/v1/responses";
    const result = await request(endpoint, body);
    report.checks.push({ name: format, status: result.res.status, relayCalls: result.calls, marker: result.text.includes(marker) });
    assert.equal(result.res.status, 200, `${format} HTTP status`);
    assert.equal(result.calls, 1);
    assert.ok(result.text.includes(marker), `${format} missing expected output`);
    const local = await request(endpoint, body, { "x-relay-local-only": "1" });
    assert.equal(local.res.status, 412);
    assert.equal(local.calls, 0);
    report.checks.push({ name: `${format}-local-only`, passed: true, relayCalls: 0 });
  }
  if (!live) {
    const compact = await request("/v1/responses/compact", { model: "cx/gpt-6-luna", input: "Compact fixture" });
    assert.equal(compact.res.status, 200);
    assert.equal(JSON.parse(compact.text).output[0].encrypted_content, "fixture-state");
    report.checks.push({ name: "compact", passed: true, relayCalls: compact.calls });
  }
  if (process.argv.includes("--ui")) {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
    await context.addCookies(cookie.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: base })));
    const page = await context.newPage();
    await page.goto(base + "/dashboard/providers/codex", { waitUntil: "networkidle" });
    await page.getByText(/No separate ch-relay connection or API key is needed/).waitFor();
    await page.screenshot({ path: path.join(scratch, "codex-auto-relay-ui.png"), fullPage: true, animations: "disabled" });
    report.checks.push({ name: "codex-ui-routing-notice", passed: true });
  }
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL"; report.error = error.message; process.exitCode = 1;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const exited = once(app, "exit"); app.kill();
    await Promise.race([exited, pause(5000)]);
    stopped = app.exitCode !== null || app.signalCode !== null;
  } else stopped = true;
  if (bridge) { bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); }
  const target = path.resolve(run), boundary = path.resolve(scratch) + path.sep;
  assert.ok(target.startsWith(boundary) && path.basename(target).startsWith("codex-relay-smoke-"));
  if (stopped) { fs.rmSync(target, { recursive: true, force: true }); report.sensitiveTestStateRemoved = true; }
  else { report.sensitiveTestStateRemoved = false; report.result = "FAIL"; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(scratch, `codex-relay-${live ? "live" : "fixture"}-report.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
