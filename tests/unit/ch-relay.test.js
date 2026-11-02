import { afterEach, describe, expect, it, vi } from "vitest";
import { ChRelayExecutor } from "../../open-sse/executors/ch-relay.js";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";
import { resolveChRelayBaseUrl } from "../../open-sse/services/chRelay/connection.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { parseModel } from "../../open-sse/services/model.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

export const textReply = () => Response.json({
  id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "gpt-6-luna",
  choices: [{ index: 0, message: { role: "assistant", content: "RELAY_OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
});

const scopeHeaders = { "x-relay-cache": "allow", "x-relay-cache-scope": "fixture-v1", authorization: "Bearer client-a" };
function setup(config = {}, fetchImpl = vi.fn(async () => textReply())) {
  const current = { ...structuredClone(chRelayDefaults), ...config };
  const policy = new PolicyEngine({ readConfig: () => current });
  const executor = new ChRelayExecutor({ fetchImpl, policy });
  const call = (body = {}, rawHeaders = {}, credentials = {}) => executor.execute({
    model: "gpt-6-luna", stream: false,
    body: { messages: [{ role: "user", content: "Reply RELAY_OK" }], ...body },
    credentials: { apiKey: "relay-key", connectionId: "connection-a", rawHeaders: { ...scopeHeaders, ...rawHeaders }, ...credentials },
  });
  return { current, policy, executor, call, fetchImpl };
}

describe("ch-relay provider", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("registers alias and lossless native Responses transport", () => {
    expect(PROVIDERS["ch-relay"].format).toBe("openai");
    expect(parseModel("chr/gpt-6-luna")).toMatchObject({ provider: "ch-relay", model: "gpt-6-luna" });
    expect(resolveTransport("ch-relay", "openai-responses").format).toBe("openai-responses");
  });

  it.each([undefined, "http://localhost:11500", "http://127.0.0.1:11500/v1/"])("normalizes local URL %s", (url) => {
    expect(resolveChRelayBaseUrl(url)).toBe("http://127.0.0.1:11500/v1");
  });
  it.each(["https://example.com/v1", "http://127.0.0.1.evil/v1", "file:///etc/passwd", "http://user:pass@localhost:11500/v1", "http://localhost:11500/v1?key=secret", "http://localhost:11500/admin", "http://192.168.1.1/v1"])("rejects URL %s", (url) => {
    expect(() => resolveChRelayBaseUrl(url)).toThrow();
  });

  it("uses the Docker service only when its exact origin is approved by the operator", () => {
    vi.stubEnv("CH_RELAY_BASE_URL", "http://ch-relay:11500/v1");
    expect(() => resolveChRelayBaseUrl()).toThrow();
    vi.stubEnv("CH_RELAY_ALLOWED_ORIGINS", "http://ch-relay:11500");
    expect(resolveChRelayBaseUrl()).toBe("http://ch-relay:11500/v1");
    expect(resolveChRelayBaseUrl("")).toBe("http://ch-relay:11500/v1");
  });

  it.each(["http://ch-relay:11501/v1", "https://ch-relay:11500/v1", "http://ch-relay.evil:11500/v1", "http://ch-relay:11500/v1?key=secret", "http://user@ch-relay:11500/v1"])("rejects allowlist near-match %s", url => {
    vi.stubEnv("CH_RELAY_ALLOWED_ORIGINS", "http://ch-relay:11500");
    expect(() => resolveChRelayBaseUrl(url)).toThrow();
  });

  it.each(["http://*:11500", "http://ch-relay:11500/v1", "http://user@ch-relay:11500", "file://ch-relay"])("rejects malformed origin policy %s", origin => {
    vi.stubEnv("CH_RELAY_ALLOWED_ORIGINS", origin);
    expect(() => resolveChRelayBaseUrl("http://ch-relay:11500/v1")).toThrow();
  });

  it("makes one relay call then replays with zero usage and new IDs", async () => {
    const { call, fetchImpl } = setup();
    const first = await call();
    expect(first.response.headers.get("x-relay-cache")).toBe("miss");
    expect((await first.response.json()).usage.total_tokens).toBe(14);
    const hit = await call({}, { "x-relay-local-only": "1" });
    const data = await hit.response.json();
    expect(hit.response.headers.get("x-relay-cache")).toBe("hit");
    expect(hit.response.headers.get("x-relay-upstream-requests")).toBe("0");
    expect(data.usage.total_tokens).toBe(0);
    expect(data.id).not.toBe("chatcmpl-fixture");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11500/v1/chat/completions");
    expect(init.headers.get("authorization")).toBe("Bearer relay-key");
    expect([...init.headers.keys()].some(name => name.startsWith("x-relay-"))).toBe(false);
  });

  it.each([
    [{ authorization: "Bearer client-b" }, {}],
    [{ "x-relay-cache-scope": "another-task" }, {}],
    [{}, { apiKey: "another-relay-key" }],
    [{}, { connectionId: "another-connection" }],
    [{}, { providerSpecificData: { chatgptAccountId: "account-b" } }],
  ])("isolates cache by caller, scope, credential, connection and account", async (headers, creds) => {
    const { call, fetchImpl } = setup();
    await (await call()).response.text();
    const miss = await call({}, { ...headers, "x-relay-local-only": "1" }, creds);
    expect(miss.response.status).toBe(412);
    await miss.response.text();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tools: [{ type: "function", function: { name: "tool", parameters: {} } }] },
    { previous_response_id: "resp-state" },
    { store: true },
    { messages: [{ role: "tool", tool_call_id: "call-1", content: "changing data" }] },
  ])("never serves tools or mutable state from cache", async body => {
    const { call, fetchImpl } = setup();
    const result = await call(body, { "x-relay-local-only": "1" });
    expect(result.response.status).toBe(412);
    await result.response.text();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deduplicates identical tools, preserves differing schemas, and honors token-saver off", async () => {
    const { call, fetchImpl } = setup();
    const tool = { type: "function", function: { name: "read", parameters: { type: "object" } } };
    const other = { type: "function", function: { name: "read", parameters: { type: "string" } } };
    await (await call({ tools: [tool, tool, other] })).response.text();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tools).toEqual([tool, other]);
    await (await call({ tools: [tool, tool] }, { "x-9router-token-saver": "off" })).response.text();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).tools).toEqual([tool, tool]);
  });

  it("preserves Responses encrypted reasoning and tool output", async () => {
    const { executor, fetchImpl } = setup();
    const input = [{ type: "reasoning", encrypted_content: "opaque-state" }, { type: "function_call_output", call_id: "call-1", output: "full tool output" }];
    const result = await executor.execute({ model: "gpt-6-luna", stream: true, body: { input }, credentials: { apiKey: "key", runtimeTransport: { format: "openai-responses" } } });
    await result.response.text();
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/v1\/responses$/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).input).toEqual(input);
  });

  it("requires both policy and caller consent for truncation/explicit effort downgrade", async () => {
    const { call, fetchImpl } = setup({ context: { deduplicateTools: true, maxToolOutputChars: 256 }, reasoning: { models: { "gpt-6-luna": { supported: ["low", "high"], maxEffort: "low", allowExplicitDowngrade: true } } } });
    const body = { reasoning_effort: "high", messages: [{ role: "tool", tool_call_id: "call-1", content: "A".repeat(1000) }] };
    await (await call(body)).response.text();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject(body);
    await (await call(body, { "x-relay-context": "truncate-tool-output", "x-relay-reasoning": "allow-downgrade" })).response.text();
    const optimized = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(optimized.reasoning_effort).toBe("low");
    expect(optimized.messages[0].content.length).toBeLessThanOrEqual(256);
    expect(optimized.messages[0].tool_call_id).toBe("call-1");
  });

  it.each(["off", "dry-run"])("local-only cannot fall through in %s mode", async mode => {
    const { call, fetchImpl } = setup({ mode });
    const result = await call({}, { "x-relay-local-only": "1" });
    expect(result.response.status).toBe(412);
    await result.response.text();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks locally without retries when kill switch is enabled", async () => {
    const { call, fetchImpl } = setup({ killSwitch: "block" });
    const result = await call();
    expect(result.response.status).toBe(503);
    await result.response.text();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not cache errors or retry a relay request", async () => {
    const { call, fetchImpl } = setup({}, vi.fn(async () => Response.json({ error: { message: "limited" } }, { status: 429, headers: { "retry-after": "10" } })));
    const result = await call();
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("10");
    await result.response.text();
    expect((await call({}, { "x-relay-local-only": "1" })).response.status).toBe(412);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects outbound proxy configuration instead of silently bypassing it", async () => {
    const { executor, fetchImpl } = setup();
    await expect(executor.execute({ proxyOptions: { strictProxy: true } })).rejects.toThrow("outbound proxy setting");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
