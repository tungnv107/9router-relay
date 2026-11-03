import http from "node:http";
import { Readable } from "node:stream";
import { fetch as directFetch } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityRelayExecutor } from "../../open-sse/executors/antigravity-relay.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { ANTIGRAVITY_RELAY } from "../../open-sse/config/antigravityRelay.mjs";
import { createAntigravityHandler } from "../../open-sse/services/chRelay/googleGateway.mjs";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const fixtureBody = { response: { candidates: [{ content: { role: "model", parts: [{ text: "GOOGLE_RELAY_OK", thoughtSignature: "signed-output" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 } } };
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

describe("Antigravity OAuth through ch-relay and a real HTTP Google fixture", () => {
  let relay, google, base, calls, relayCalls, executor, status, responseBody, responseHeaders;
  beforeAll(async () => {
    google = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      calls.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const streaming = req.url.includes("streamGenerateContent");
      res.writeHead(status, { "content-type": streaming ? "text/event-stream" : "application/json", ...(status === 429 ? { "retry-after": "60" } : {}), ...responseHeaders });
      res.end(status !== 200 ? JSON.stringify({ error: { code: status, message: "Google fixture error" } }) : streaming ? `data: ${JSON.stringify(responseBody)}\n\n` : JSON.stringify(responseBody));
    });
    await listen(google);
    const handler = createAntigravityHandler({ fetchImpl: (target, init) => {
      expect(new URL(target).origin).toBe(ANTIGRAVITY_RELAY.upstreamOrigin);
      const { proxy, ...options } = init;
      expect(proxy).toBe("");
      return directFetch(`http://127.0.0.1:${google.address().port}${new URL(target).pathname}${new URL(target).search}`, options);
    } });
    relay = http.createServer(async (req, res) => {
      try {
        relayCalls.push(req.url);
        const response = await handler(new Request(`http://127.0.0.1${req.url}`, {
          method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: "half",
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        for await (const chunk of response.body || []) res.write(chunk);
        res.end();
      } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    await listen(relay);
    base = `http://127.0.0.1:${relay.address().port}/v1`;
  });
  beforeEach(() => {
    calls = []; relayCalls = []; status = 200;
    responseBody = structuredClone(fixtureBody); responseHeaders = {};
    vi.stubEnv("CH_RELAY_BASE_URL", base);
    vi.stubEnv("CH_RELAY_ALLOWED_ORIGINS", "");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected direct fetch"));
    executor = new AntigravityRelayExecutor({ policy: new PolicyEngine({ readConfig: () => chRelayDefaults }) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await close(relay); await close(google); });

  const args = (extra = {}) => ({
    model: "gemini-2.5-flash", stream: false,
    body: { request: { contents: [{ role: "user", parts: [{ text: "Reply GOOGLE_RELAY_OK" }] }] } },
    credentials: { accessToken: "google-access-token", refreshToken: "private-refresh", projectId: "google-project", connectionId: "google-account" },
    ...extra,
  });

  it("registers the automatic relay for existing Antigravity accounts", () => {
    expect(getExecutor("antigravity")).toBeInstanceOf(AntigravityRelayExecutor);
    expect(getExecutor("antigravity").getProvider()).toBe("antigravity");
  });

  it.each([false, true])("forwards native Google JSON/SSE (stream=%s) and the selected access token", async stream => {
    const result = await executor.execute(args({ stream }));
    expect(result.url).toBe(`${base}/antigravity/v1internal:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
    expect(await result.response.text()).toContain("GOOGLE_RELAY_OK");
    expect(relayCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ project: "google-project", model: "gemini-2.5-flash" });
    expect(calls[0].headers.authorization).toBe("Bearer google-access-token");
    expect(calls[0].headers["user-agent"]).toContain("antigravity/");
    expect(JSON.stringify(calls)).not.toContain("private-refresh");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([[false, "gemini-2.5-flash"], [true, "gemini-2.5-flash"], [false, "claude-sonnet-4-6"], [true, "claude-sonnet-4-6"]])("replays native text through real HTTP with zero additional Google calls (stream=%s, model=%s)", async (stream, model) => {
    delete responseBody.response.candidates[0].content.parts[0].thoughtSignature;
    const request = args({ stream, model });
    request.credentials.rawHeaders = { authorization: "Bearer router-key-a", "x-relay-cache": "allow", "x-relay-cache-scope": "static-fixture" };
    request.body.requestId = "agent/conversation/1/trajectory/1";
    const cold = await executor.execute(request);
    expect(await cold.response.text()).toContain('"totalTokenCount":14');
    request.body.requestId = "agent/conversation/2/trajectory/1";
    request.credentials.rawHeaders["x-relay-local-only"] = "1";
    const warm = await executor.execute(request);
    expect(warm.response.status).toBe(200);
    expect(warm.response.headers.get("x-relay-cache")).toBe("hit");
    expect(warm.response.headers.get("x-relay-upstream-requests")).toBe("0");
    expect(await warm.response.text()).toContain('"totalTokenCount":0');
    expect(calls).toHaveLength(1); expect(relayCalls).toHaveLength(1);
    expect(Object.keys(calls[0].headers).some(key => key.startsWith("x-relay-"))).toBe(false);
    request.credentials.rawHeaders.authorization = "Bearer router-key-b";
    const otherCaller = await executor.execute(request);
    expect(otherCaller.response.status).toBe(412); await otherCaller.response.text();
    expect(calls).toHaveLength(1);
  });

  it.each(["cookie", "idempotency-key", "x-9router-token-saver"])("honors native cache opt-out via %s before relay HTTP", async header => {
    delete responseBody.response.candidates[0].content.parts[0].thoughtSignature;
    const request = args();
    request.credentials.rawHeaders = { "x-relay-cache": "allow", "x-relay-cache-scope": "static-fixture" };
    await (await executor.execute(request)).response.text();
    request.credentials.rawHeaders[header] = header === "x-9router-token-saver" ? "off" : "private";
    const bypass = await executor.execute(request);
    expect(bypass.response.headers.get("x-relay-cache")).toBe("bypass");
    await bypass.response.text(); expect(calls).toHaveLength(2);
  });

  it("preserves upstream no-store across the Google gateway", async () => {
    delete responseBody.response.candidates[0].content.parts[0].thoughtSignature;
    responseHeaders = { "cache-control": "no-store" };
    const request = args();
    request.credentials.rawHeaders = { "x-relay-cache": "allow", "x-relay-cache-scope": "static-fixture" };
    await (await executor.execute(request)).response.text();
    await (await executor.execute(request)).response.text();
    expect(calls).toHaveLength(2);
  });

  it.each(["enforce", "dry-run", "off"])("applies model-specific native thinking through HTTP in %s mode", async mode => {
    const policy = new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, mode, reasoning: { models: {}, antigravityModels: { "gemini-2.5-flash": { field: "thinkingBudget", maxValue: 2048, allowExplicitDowngrade: true } } } }) });
    executor = new AntigravityRelayExecutor({ policy });
    const request = args();
    request.body.request.generationConfig = { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } };
    request.credentials.rawHeaders = { "x-relay-reasoning": "allow-downgrade" };
    await (await executor.execute(request)).response.text();
    expect(calls[0].body.request.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: mode === "enforce" ? 2048 : 4096, includeThoughts: true } });
    expect(calls[0].body.reasoning).toBeUndefined();
    expect(calls[0].body.prompt_cache_key).toBeUndefined();
    expect(request.body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(4096);
  });

  it("ignores forged auth, ChatGPT headers and per-account URLs without mutating credentials", async () => {
    const request = args();
    request.credentials.apiKey = "wrong-key";
    request.credentials.providerSpecificData = { baseUrl: "https://untrusted.example/v1", chatgptAccountId: "wrong-account" };
    request.credentials.rawHeaders = { authorization: "Bearer router-secret", cookie: "private-cookie", "x-relay-cache": "allow" };
    request.providerOverrides = { headers: { Authorization: "Bearer forged", "x-api-key": "secret", "user-agent": "antigravity/test" } };
    const original = structuredClone(request);
    await (await executor.execute(request)).response.text();
    expect(calls[0].headers.authorization).toBe("Bearer google-access-token");
    expect(calls[0].headers["user-agent"]).toBe("antigravity/test");
    for (const key of ["chatgpt-account-id", "x-api-key", "cookie", "x-relay-cache"]) expect(calls[0].headers[key]).toBeUndefined();
    expect(request).toEqual(original);
  });

  it("keeps image requests on generateContent and preserves reference image bytes", async () => {
    const request = args({ model: "gemini-3.1-flash-image", stream: true, body: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }, { text: "Draw" }] }] } });
    await (await executor.execute(request)).response.text();
    expect(calls[0].path).toBe(ANTIGRAVITY_RELAY.generatePath);
    expect(JSON.stringify(calls[0].body)).toContain("aW1hZ2U=");
  });

  it.each(["enforce", "dry-run", "off"])("applies native context policy through real relay HTTP only in %s mode", async mode => {
    const policy = new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, mode, context: { deduplicateTools: true, maxToolOutputChars: 256 } }) });
    executor = new AntigravityRelayExecutor({ policy });
    const request = args();
    request.credentials.rawHeaders = { "x-relay-context": "truncate-tool-output" };
    request.body.request.contents = [
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "read", args: {} }, thoughtSignature: "opaque-signature" }] },
      { role: "user", parts: [{ functionResponse: { id: "call_1", name: "read", response: { result: "x".repeat(2000) } } }] },
    ];
    request.body.request.generationConfig = { thinkingConfig: { thinkingBudget: 8192 }, maxOutputTokens: 16384 };
    const original = structuredClone(request);
    await (await executor.execute(request)).response.text();
    const wire = calls[0].body.request;
    const parts = wire.contents.flatMap(content => content.parts);
    const text = parts.find(part => part.functionResponse).functionResponse.response.result;
    if (mode === "enforce") {
      expect(text.length).toBeLessThanOrEqual(256);
      expect(text).toContain("LOCAL POLICY");
    } else expect(text).toBe("x".repeat(2000));
    expect(parts.find(part => part.functionCall).thoughtSignature).toBe("opaque-signature");
    expect(parts.find(part => part.functionResponse).functionResponse.id).toBe("call_1");
    expect(wire.generationConfig).toEqual(request.body.request.generationConfig);
    expect(calls[0].headers["x-relay-context"]).toBeUndefined();
    expect(relayCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(request).toEqual(original);
  });

  it.each([false, true])("requires context opt-in and respects token-saver opt-out=%s", async optOut => {
    executor = new AntigravityRelayExecutor({ policy: new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, context: { deduplicateTools: true, maxToolOutputChars: 256 } }) }) });
    const request = args();
    request.body.request.contents = [{ role: "user", parts: [{ functionResponse: { id: "c", name: "read", response: { result: "x".repeat(2000) } } }] }];
    if (optOut) request.credentials.rawHeaders = { "x-relay-context": "truncate-tool-output", "x-9router-token-saver": "off" };
    await (await executor.execute(request)).response.text();
    expect(calls[0].body.request.contents[0].parts[0].functionResponse.response.result).toHaveLength(2000);
    expect(Object.keys(calls[0].headers).some(name => name.startsWith("x-relay-"))).toBe(false);
  });

  it.each([401, 403, 429])("returns Google HTTP %s and retry metadata unchanged", async code => {
    status = code;
    const result = await executor.execute(args());
    expect(result.response.status).toBe(code);
    expect((await result.response.json()).error.code).toBe(code);
    expect(calls).toHaveLength(1);
    if (code === 429) expect(result.response.headers.get("retry-after")).toBe("60");
  });

  it.each(["kill", "local-only"])("enforces %s without calling the relay or Google", async guard => {
    const policy = new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, ...(guard === "kill" ? { killSwitch: "block" } : {}) }) });
    executor = new AntigravityRelayExecutor({ policy });
    const request = args();
    if (guard === "local-only") request.credentials.rawHeaders = { "x-relay-local-only": "1" };
    const result = await executor.execute(request);
    expect(result.response.status).toBe(guard === "kill" ? 503 : 412);
    expect(result.response.headers.get("x-relay-upstream-requests")).toBe("0");
    await result.response.text();
    expect(relayCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("never falls back to direct Google when the relay is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Relay offline"));
    executor = new AntigravityRelayExecutor({ fetchImpl });
    executor.config = { ...executor.config, retry: { "502": { attempts: 0 } } };
    await expect(executor.execute(args())).rejects.toThrow("Relay offline");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("releases policy streams from transient errors before retrying the relay", async () => {
    const policy = new PolicyEngine({ readConfig: () => chRelayDefaults });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "Temporary capacity" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(fixtureBody));
    executor = new AntigravityRelayExecutor({ fetchImpl, policy });
    vi.spyOn(executor, "computeRetryDelay").mockResolvedValue(0);
    const result = await executor.execute(args());
    await result.response.text();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(policy.active.size).toBe(0);
  });

  it("rejects unapproved origins and proxy settings before sending a credential", async () => {
    vi.stubEnv("CH_RELAY_BASE_URL", "https://untrusted.example/v1");
    await expect(executor.execute(args())).rejects.toThrow("operator-approved");
    expect(() => executor.execute(args({ proxyOptions: { connectionProxyEnabled: true } }))).toThrow("connects directly");
    expect(relayCalls).toHaveLength(0);
  });

  it("routes the separate web-search API through the same Google relay", async () => {
    const result = await handleChatSearch({ provider: "antigravity", query: "fixture query", credentials: args().credentials });
    expect(result.success).toBe(true);
    expect(relayCalls).toEqual(["/v1/antigravity/v1internal:generateContent"]);
    expect(calls[0].body.project).toBe("google-project");
    expect(calls[0].headers.authorization).toBe("Bearer google-access-token");
  });
});
