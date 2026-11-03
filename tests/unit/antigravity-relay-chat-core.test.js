import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import * as proxyTransport from "../../open-sse/utils/proxyFetch.js";
import { AntigravityRelayExecutor } from "../../open-sse/executors/antigravity-relay.js";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";

const state = vi.hoisted(() => ({ executor: null, fetch: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => state.executor }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, { get: (_, key) => key === "then" ? undefined : () => {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const payload = { response: {
  candidates: [{ content: { role: "model", parts: [{ text: "GOOGLE_RELAY_OK" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
} };
const upstream = url => url.includes("streamGenerateContent")
  ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
  : Response.json(payload);
const call = (stream = false, extra = {}) => {
  const body = { model: "ag/gemini-2.5-flash", stream, messages: [{ role: "user", content: "Reply GOOGLE_RELAY_OK" }], ...(stream ? { stream_options: { include_usage: true } } : {}) };
  return handleChatCore({
    body, modelInfo: { provider: "antigravity", model: "gemini-2.5-flash" },
    credentials: { accessToken: "expired-access", refreshToken: "google-refresh", projectId: "real-project", connectionId: "existing-google" },
    connectionId: "existing-google", log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { authorization: "Bearer router-key" } },
    ...extra,
  });
};

describe("Antigravity relay through chatCore with Google OAuth refresh", () => {
  beforeEach(() => {
    vi.stubEnv("CH_RELAY_BASE_URL", "http://127.0.0.1:11500/v1");
    state.fetch.mockReset().mockImplementation(upstream);
    state.executor = new AntigravityRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => chRelayDefaults }) });
    state.executor.config = { ...state.executor.config, clientId: "test-client", clientSecret: "test-client-secret" };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([false, true])("translates OpenAI input and returns Google usage (stream=%s)", async stream => {
    const result = await call(stream);
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("GOOGLE_RELAY_OK");
    expect(text).toContain('"total_tokens":14');
    expect(text).not.toContain('"total_tokens":2014');
    expect(state.fetch).toHaveBeenCalledOnce();
    const [url, options] = state.fetch.mock.calls[0];
    expect(url).toContain("/v1/antigravity/v1internal:");
    expect(options.headers.get("authorization")).toBe("Bearer expired-access");
    expect(JSON.parse(options.body).project).toBe("real-project");
    expect(JSON.stringify(options)).not.toContain("google-refresh");
  });

  it.each([401, 403])("refreshes after Google HTTP %s and retries the relay with the new token", async status => {
    state.fetch.mockImplementationOnce(async () => Response.json({ error: { message: "Expired Google token" } }, { status }));
    const refreshFetch = vi.spyOn(proxyTransport, "proxyAwareFetch").mockImplementation(async (url, options) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(Object.fromEntries(options.body)).toEqual({ grant_type: "refresh_token", refresh_token: "google-refresh", client_id: "test-client", client_secret: "test-client-secret" });
      return Response.json({ access_token: "fresh-google-access", refresh_token: "rotated-google-refresh", expires_in: 3600 });
    });
    const persist = vi.fn();
    const result = await call(false, { onCredentialsRefreshed: persist });
    expect(result.success).toBe(true);
    expect(await result.response.text()).toContain("GOOGLE_RELAY_OK");
    expect(refreshFetch).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith({ accessToken: "fresh-google-access", refreshToken: "rotated-google-refresh", expiresIn: 3600, projectId: "real-project" });
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.fetch.mock.calls[1][0]).toBe(state.fetch.mock.calls[0][0]);
    expect(state.fetch.mock.calls[1][1].headers.get("authorization")).toBe("Bearer fresh-google-access");
    expect(state.fetch.mock.calls[1][1].body).not.toContain("refresh");
    expect(state.executor.relayOptions.policy.active.size).toBe(0);
  });

  it.each(["gemini-3.8-flash-high", "claude-sonnet-4-6"])("RTK reduces actual relay payload for %s and preserves opt-out", async model => {
    const output = Array.from({ length: 80 }, (_, i) => `src/file.js:${i + 1}:matching source line with enough content to compress`).join("\n");
    const wire = [];
    for (const enabled of [false, true]) {
      const body = { model: `ag/${model}`, stream: false, messages: [
        { role: "user", content: "Read matches" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: output },
        { role: "user", content: "Summarize" },
      ] };
      const result = await call(false, { body, modelInfo: { provider: "antigravity", model }, rtkEnabled: true,
        clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { "x-9router-token-saver": enabled ? "on" : "off" } },
      });
      expect(result.success).toBe(true);
      await result.response.text();
      wire.push(JSON.parse(state.fetch.mock.calls.at(-1)[1].body));
    }
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(wire[1]).length).toBeLessThan(JSON.stringify(wire[0]).length * 0.6);
    for (const payload of wire) {
      const parts = payload.request.contents.flatMap(content => content.parts);
      expect(parts.find(part => part.functionCall).functionCall.id).toBe("call_1");
      expect(parts.find(part => part.functionResponse).functionResponse.id).toBe("call_1");
    }
    expect(wire[1].request.generationConfig).toEqual(wire[0].request.generationConfig);
    console.log(`[Antigravity RTK fixture] ${model}: ${Buffer.byteLength(JSON.stringify(wire[0]))} -> ${Buffer.byteLength(JSON.stringify(wire[1]))} outbound bytes (not measured quota)`);
  });

  it.each([
    ["gemini-3.8-flash-high", false], ["gemini-3.8-flash-high", true],
    ["claude-sonnet-4-6", false], ["claude-sonnet-4-6", true],
  ])("preserves Claude error output through translation, RTK and native context policy for %s (array=%s)", async (model, asArray) => {
    state.executor = new AntigravityRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => ({
      ...chRelayDefaults, context: { deduplicateTools: true, maxToolOutputChars: 256 },
    }) }) });
    const output = Array.from({ length: 80 }, (_, i) => `src/file.js:${i + 1}:important error trace with enough content to compress`).join("\n");
    const body = { model: `ag/${model}`, stream: false, max_tokens: 1024, messages: [
      { role: "user", content: "Read" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_error", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_error", is_error: true, content: asArray ? [{ type: "text", text: output }] : output }] },
    ] };
    const result = await call(false, { body, modelInfo: { provider: "antigravity", model }, sourceFormatOverride: "claude", rtkEnabled: true,
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { "x-relay-context": "truncate-tool-output" } },
    });
    expect(result.success).toBe(true);
    await result.response.text();
    expect(state.fetch.mock.calls[0][1].body).toContain(JSON.stringify(output).slice(1, -1));
    const parts = JSON.parse(state.fetch.mock.calls[0][1].body).request.contents.flatMap(content => content.parts);
    expect(parts.find(part => part.functionResponse).functionResponse.response.result.error).toBe(output);
  });

  it("preserves local policy denials for account rotation handling", async () => {
    state.executor = new AntigravityRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, killSwitch: "block" }) }) });
    const result = await call();
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("x-relay-upstream-requests")).toBe("0");
    await result.response.text();
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
