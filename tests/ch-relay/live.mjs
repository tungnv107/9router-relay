// Explicit real-upstream test. Uses an isolated 9router database, never the running app's state.
// Run after npm run build: node tests/ch-relay/live.mjs [--ui]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = path.join(root, ".scratch");
fs.mkdirSync(scratch, { recursive: true });
const run = fs.mkdtempSync(path.join(scratch, "ch-relay-live-"));
const dataDir = path.join(run, "data");
fs.mkdirSync(dataDir);
const report = { startedAt: new Date().toISOString(), syntheticPromptsOnly: true, productionModified: false, checks: [] };
let app, bridge, browser, stopped = false, log = "", relayPosts = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
};

try {
  assert.ok(fs.existsSync(path.join(root, ".next/BUILD_ID")), "Build 9router before running the live check");
  const authPath = process.env.CH_RELAY_TEST_AUTH_FILE || path.join(os.homedir(), ".codex", "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const token = auth.tokens?.access_token;
  assert.ok(token, "An existing ChatGPT access token is required");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.ok(claims.exp * 1000 > Date.now(), "Existing token expired; test does not refresh it");

  // Transparent loopback observer counts every 9router -> relay request without logging secrets/body.
  bridge = http.createServer((req, res) => {
    if (req.method === "POST") relayPosts++;
    const forwarded = http.request({ hostname: "127.0.0.1", port: 11500, path: req.url, method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:11500" } }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    forwarded.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => forwarded.destroy());
    req.pipe(forwarded);
  });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const bridgePort = bridge.address().port;
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const password = randomBytes(20).toString("hex");
  const env = { ...process.env, DATA_DIR: dataDir, INITIAL_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"),
    NEXT_TELEMETRY_DISABLED: "1", ENABLE_REQUEST_LOGS: "false", OBSERVABILITY_ENABLED: "false", REQUIRE_API_KEY: "false", NODE_ENV: "production" };
  delete env.CH_RELAY_POLICY_FILE; delete env.CH_RELAY_POLICY_KILL;
  app = spawn(process.execPath, ["custom-server.js", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  // Never print app logs: existing 9router loggers can contain account identifiers.
  app.stdout.on("data", chunk => { log = (log + chunk.toString()).slice(-20000); });
  app.stderr.on("data", chunk => { log = (log + chunk.toString()).slice(-20000); });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error("Isolated 9router exited before readiness");
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) }); await r.text(); if (r.ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert.ok(ready, "Isolated 9router did not become ready");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200, "Test dashboard login failed");
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await login.text();
  const admin = async (url, body, method = body ? "POST" : "GET") => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json", cookie, origin: base }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    return { status: response.status, data: await response.json() };
  };
  const keyA = await admin("/api/keys", { name: "Integration client A" });
  const keyB = await admin("/api/keys", { name: "Integration client B" });
  assert.equal(keyA.status, 201); assert.equal(keyB.status, 201);
  const invalid = await admin("/api/providers", { provider: "ch-relay", name: "invalid fixture", apiKey: "synthetic", providerSpecificData: { baseUrl: "https://example.com/v1" } });
  assert.equal(invalid.status, 400);
  const connection = await admin("/api/providers", { provider: "ch-relay", name: "Integration fixture", apiKey: token,
    providerSpecificData: { baseUrl: `http://127.0.0.1:${bridgePort}/v1`, chatgptAccountId: auth.tokens.account_id }, testStatus: "active" });
  assert.equal(connection.status, 201, "Failed to create isolated connection");
  const id = connection.data.connection.id;
  assert.ok(!JSON.stringify(connection.data).includes(token), "Provider response leaked a credential");
  const discovery = await admin(`/api/providers/${id}/models`);
  assert.equal(discovery.status, 200);
  assert.ok(discovery.data.models.some(model => model.id === "gpt-6-luna"));
  const probe = await admin(`/api/providers/${id}/test`, {});
  assert.equal(probe.data.valid, true);
  report.checks.push({ name: "provider-create-discovery-probe", passed: true, inferenceCalls: relayPosts });
  assert.equal(relayPosts, 0, "Discovery or probe unexpectedly performed inference");

  if (!process.argv.includes("--ui-only")) {
  const marker = "NINEROUTER_HTTP_RELAY_OK";
  const body = { model: "chr/gpt-6-luna", stream: false, reasoning_effort: "low", messages: [{ role: "user", content: `Synthetic connectivity test. Reply exactly ${marker}. No tools.` }] };
  const inference = async (body, extra = {}, endpoint = "/v1/chat/completions") => {
    const before = relayPosts, started = performance.now();
    const response = await fetch(base + endpoint, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${keyA.data.key}`, "x-relay-cache": "allow", "x-relay-cache-scope": "9router-http-live-v1", ...extra,
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch {}
    return { response, text, data, summary: { status: response.status, cache: response.headers.get("x-relay-cache"), relayCalls: relayPosts - before,
      latencyMs: Math.round(performance.now() - started), marker: text.includes(marker), usage: data?.usage ?? null } };
  };
  const first = await inference(body);
  report.checks.push({ name: "json-warm-up", ...first.summary });
  assert.equal(first.summary.status, 200); assert.ok(first.summary.marker); assert.equal(first.summary.relayCalls, 1);
  const replay = await inference(body, { "x-relay-local-only": "1" });
  report.checks.push({ name: "json-local-replay", ...replay.summary });
  assert.equal(replay.summary.status, 200); assert.equal(replay.summary.cache, "hit"); assert.ok(replay.summary.marker);
  assert.equal(replay.summary.relayCalls, 0); assert.equal(replay.data.usage.total_tokens, 0);
  for (const extra of [{ "x-relay-cache-scope": "fresh-scope" }, { authorization: `Bearer ${keyB.data.key}` }]) {
    const miss = await inference(body, { ...extra, "x-relay-local-only": "1" });
    assert.equal(miss.summary.status, 412); assert.equal(miss.summary.relayCalls, 0);
  }
  const wrongProvider = await inference({ ...body, model: "openai/gpt-4o" }, { "x-relay-local-only": "1" });
  assert.equal(wrongProvider.summary.status, 412); assert.equal(wrongProvider.summary.relayCalls, 0);
  report.checks.push({ name: "scope-caller-provider-isolation", passed: true });

  const streaming = await inference({ ...body, stream: true, stream_options: { include_usage: true } });
  report.checks.push({ name: "sse-warm-up", ...streaming.summary });
  assert.equal(streaming.summary.status, 200); assert.ok(streaming.summary.marker); assert.ok(streaming.text.includes("[DONE]"));
  const streamReplay = await inference({ ...body, stream: true, stream_options: { include_usage: true } }, { "x-relay-local-only": "1" });
  report.checks.push({ name: "sse-local-replay", ...streamReplay.summary });
  assert.equal(streamReplay.summary.status, 200); assert.equal(streamReplay.summary.cache, "hit");
  assert.equal(streamReplay.summary.relayCalls, 0); assert.ok(streamReplay.summary.marker);
  const usageEvents = streamReplay.text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).usage).filter(Boolean);
  assert.ok(usageEvents.length > 0); assert.ok(usageEvents.every(usage => usage.total_tokens === 0));
  report.checks.find(check => check.name === "sse-local-replay").usage = usageEvents.at(-1);

  const native = await inference({ model: "chr/gpt-6-luna", stream: true, reasoning: { effort: "low" }, input: [{ role: "user", content: [{ type: "input_text", text: `Reply exactly ${marker}.` }] }] }, { "x-relay-cache": "bypass" }, "/v1/responses");
  report.checks.push({ name: "responses-native-stream", ...native.summary });
  assert.equal(native.summary.status, 200); assert.ok(native.summary.marker); assert.ok(native.text.includes("response.completed"));
  }

  if (process.argv.includes("--ui") || process.argv.includes("--ui-only")) {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: "reduce" });
    await context.addCookies(cookie.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: base })));
    const page = await context.newPage();
    await page.goto(base + "/dashboard/providers/ch-relay", { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(root, ".scratch/ch-relay-ui-before.png"), fullPage: true });
    report.uiButtons = await page.getByRole("button").allTextContents();
    await page.getByRole("button", { name: /^add\s*Add$/i }).click();
    await page.getByText("ch-relay Base URL", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(root, "tests/ch-relay/provider-ui.png"), fullPage: true, animations: "disabled" });
    report.checks.push({ name: "provider-ui-add-form", passed: true });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^edit\s*Edit$/i }).click();
    await page.getByText("ch-relay Base URL", { exact: true }).waitFor();
    await page.waitForFunction(expected => [...document.querySelectorAll('input')].some(input => input.value === expected),
      `http://127.0.0.1:${bridgePort}/v1`, { timeout: 5000 });
    assert.equal(await page.getByPlaceholder("Leave blank to use the server's configured relay").inputValue(), `http://127.0.0.1:${bridgePort}/v1`);
    report.checks.push({ name: "provider-ui-edit-preserves-url", passed: true });
    delete report.uiButtons;
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
  // Resolve and enforce the workspace boundary before deleting this test-created credential database.
  const target = path.resolve(run), boundary = path.resolve(scratch) + path.sep;
  assert.ok(target.startsWith(boundary) && path.basename(target).startsWith("ch-relay-live-"));
  if (stopped) { fs.rmSync(target, { recursive: true, force: true }); report.sensitiveTestStateRemoved = true; }
  else { report.sensitiveTestStateRemoved = false; report.result = "FAIL"; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.totalRelayInferenceCalls = relayPosts;
  fs.writeFileSync(path.join(root, process.argv.includes("--ui-only") ? "tests/ch-relay/ui-report.json" : "tests/ch-relay/live-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
