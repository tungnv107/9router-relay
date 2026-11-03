// Runs the actual privately packaged Bun backend with an isolated profile and
// synthetic Google HTTP upstream. No production account or quota is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = path.join(root, ".scratch");
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, "antigravity-backend-"));
for (const dir of ["AppData/Roaming", "AppData/Local"]) fs.mkdirSync(path.join(profile, dir), { recursive: true });
const bun = process.env.BUN_BIN || "bun";
const freePort = async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
};
const calls = [];
const fixture = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ path: req.url, token: req.headers.authorization, body });
  if (req.headers.authorization === "Bearer expired-google") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }));
  } else if (req.url.includes("streamGenerateContent")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"response":{"text":"FIRST"}}\n\n');
    setTimeout(() => res.end('data: {"response":{"text":"LAST"}}\n\n'), 100);
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ response: { text: "GOOGLE_BACKEND_OK", thoughtSignature: "opaque" } }));
  }
});
let child, exited, output = "";
try {
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const sharePort = await freePort(), adminPort = await freePort();
  const base = `http://127.0.0.1:${sharePort}`;
  // The recovered backend can sync local CLI files during startup. Isolate its
  // entire Windows profile as well as CH_HOME; never inherit a live Codex path.
  const testEnv = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
    CH_HOME: profile, CH_PORT: "0", CH_SHARE_PORT: String(sharePort), CH_ADMIN_PORT: String(adminPort),
    CH_RELAY_BIND_HOST: "127.0.0.1", CH_QUOTA_POLL_MS: "0", CH_AUTO_POOL_GUARD: "0", CH_AUTO_UPDATE: "0", CH_TELEMETRY: "0", CH_CACHE_MS: "0",
    GOOGLE_FIXTURE_ORIGIN: `http://127.0.0.1:${fixture.address().port}` };
  delete testEnv.CODEX_HOME;
  child = spawn(bun, ["--preload", "./tests/ch-relay/google-upstream-fixture.mjs", "./vendor/ch-relay/entry.mjs", "start", "--admin-port", String(adminPort)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: testEnv,
  });
  exited = once(child, "exit");
  child.stdout.on("data", data => { output = (output + data).slice(-12000); });
  child.stderr.on("data", data => { output = (output + data).slice(-12000); });
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${output}`);
    try { healthy = (await fetch(base + "/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, `Backend did not start: ${output}`);
  const post = (route, token, body = { model: "fixture", project: "fixture-project", request: { contents: [{ role: "user", parts: [{ text: "test" }] }] } }) => fetch(base + route, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const route = "/v1/antigravity/v1internal:generateContent";
  assert.equal((await post(route)).status, 401);
  assert.equal((await post("/v1/antigravity/token", "fixture-google")).status, 404);
  assert.equal(calls.length, 0);
  const json = await post(route, "fixture-google");
  assert.equal(json.status, 200);
  assert.equal((await json.json()).response.text, "GOOGLE_BACKEND_OK");
  assert.equal(calls[0].token, "Bearer fixture-google");
  assert.equal(calls[0].body.project, "fixture-project");
  const expired = await post(route, "expired-google");
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.status, "UNAUTHENTICATED");
  const streaming = await post("/v1/antigravity/v1internal:streamGenerateContent?alt=sse", "fixture-google");
  assert.equal(streaming.status, 200);
  const reader = streaming.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /FIRST/);
  let remaining = "";
  for (;;) { const part = await reader.read(); if (part.done) break; remaining += new TextDecoder().decode(part.value); }
  assert.match(remaining, /LAST/);
  const policy = await (await fetch(`http://127.0.0.1:${adminPort}/api/network-policy`, { headers: { "x-ch-relay": "1" } })).json();
  assert.equal(policy.antigravity.authentication, "google-oauth-access-token");
  assert.deepEqual(policy.providerOrigins.openai, ["https://chatgpt.com", "https://auth.openai.com"]);
  assert.equal((await post("/v1/responses")).status, 401);
  const report = { packagedBackend: true, googleJson: true, googleStreaming: true, google401: true, unauthenticatedBlocked: true, unknownRoutesBlocked: true, openaiAuthPreserved: true, syntheticUpstreamCalls: calls.length, liveGoogleAccountTested: false };
  fs.writeFileSync(path.join(scratch, "antigravity-backend-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode === null) { child.kill(); await exited; }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  if (!path.resolve(profile).startsWith(scratch + path.sep) || !path.basename(profile).startsWith("antigravity-backend-")) throw new Error("Unexpected test cleanup path");
  fs.rmSync(profile, { recursive: true, force: true });
}
