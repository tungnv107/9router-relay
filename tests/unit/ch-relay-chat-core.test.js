import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { ChRelayExecutor } from "../../open-sse/executors/ch-relay.js";
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
const chunks = (usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }, usageOnFinish = false) => {
  const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna" };
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "CORE_OK" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usageOnFinish && usage ? { usage } : {}) },
    ...(usage && !usageOnFinish ? [{ ...base, choices: [], usage }] : []),
  ].map(part => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n";
};
const call = async (body, headers = {}) => handleChatCore({
  body: structuredClone(body), modelInfo: { provider: "ch-relay", model: "gpt-6-luna" },
  credentials: { apiKey: "relay-key", connectionId: "core-connection" }, connectionId: "core-connection",
  clientRawRequest: { endpoint: body.input ? "/v1/responses" : "/v1/chat/completions", body, headers: {
    authorization: "Bearer client-a", "x-relay-cache": "allow", "x-relay-cache-scope": "core-v1", ...headers,
  } },
  log: { debug() {}, info() {}, warn() {}, error() {} },
});
const chatBody = { model: "chr/gpt-6-luna", messages: [{ role: "user", content: "Reply CORE_OK" }], stream: false };

describe("ch-relay through real chatCore and translators", () => {
  beforeEach(() => {
    state.fetch.mockReset();
    state.executor = new ChRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => chRelayDefaults }) });
  });

  it("keeps real usage on a miss and zero on replay through the JSON handler", async () => {
    state.fetch.mockImplementation(async () => Response.json({
      id: "chatcmpl-fixture", object: "chat.completion", model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: "CORE_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }));
    const first = await call(chatBody);
    expect(first.success).toBe(true);
    expect((await first.response.json()).usage.total_tokens).toBe(14);
    const hit = await call(chatBody, { "x-relay-local-only": "1" });
    expect(hit.response.headers.get("x-relay-cache")).toBe("hit");
    expect((await hit.response.json()).usage.total_tokens).toBe(0);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves SSE usage without the 2000-token buffer or estimates (usage on finish: %s)", async usageOnFinish => {
    state.fetch.mockImplementation(async () => new Response(chunks(undefined, usageOnFinish), { headers: { "content-type": "text/event-stream" } }));
    const body = { ...chatBody, stream: true, stream_options: { include_usage: true } };
    const first = await call(body);
    const wire = await first.response.text();
    expect(wire).toContain("CORE_OK");
    const usage = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).usage).filter(Boolean);
    expect(usage).toEqual([{ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }]);
    const hit = await call(body, { "x-relay-local-only": "1" });
    expect(hit.response.headers.get("x-relay-cache")).toBe("hit");
    const replay = await hit.response.text();
    expect(replay).toContain('"total_tokens":0');
    expect(replay).not.toContain("2000");
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps missing SSE usage unknown instead of inventing token savings", async () => {
    state.fetch.mockImplementation(async () => new Response(chunks(null), { headers: { "content-type": "text/event-stream" } }));
    const result = await call({ ...chatBody, stream: true });
    expect(await result.response.text()).not.toContain('"usage"');
  });

  it("keeps Responses reasoning state, prompt cache key and tool IDs across the full request pipeline", async () => {
    const response = { id: "resp-fixture", object: "response", status: "completed", model: "gpt-6-luna",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CORE_OK", annotations: [] }] }],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } };
    state.fetch.mockImplementation(async () => new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const input = [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque-state" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "TOOL_OK" },
      { role: "user", content: [{ type: "input_text", text: "Reply CORE_OK" }] }];
    const result = await call({ model: "chr/gpt-6-luna", stream: false, input, prompt_cache_key: "caller-key", reasoning: { effort: "low" } });
    expect(result.success).toBe(true);
    const data = await result.response.json();
    expect(data.usage.total_tokens).toBe(14);
    expect(result.response.headers.get("x-relay-cache")).toBe("bypass");
    const [url, init] = state.fetch.mock.calls[0];
    expect(url).toMatch(/\/responses$/);
    const outgoing = JSON.parse(init.body);
    expect(outgoing.input).toEqual(input);
    expect(outgoing.prompt_cache_key).toBe("caller-key");
    expect(outgoing.reasoning.effort).toBe("low");
  });

  it("routes compact to its own endpoint without caching state or leaving private flags on the wire", async () => {
    state.fetch.mockImplementation(async () => Response.json({ id: "resp-compact", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "compact-state" }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }));
    const body = { model: "chr/gpt-6-luna", _compact: true, input: [{ role: "user", content: "Compact fixture" }] };
    const result = await call(body);
    expect(result.success).toBe(true);
    expect((await result.response.json()).object).toBe("response.compaction");
    const [url, init] = state.fetch.mock.calls[0];
    expect(url).toMatch(/\/responses\/compact$/);
    const outgoing = JSON.parse(init.body);
    expect(outgoing).not.toHaveProperty("_compact");
    expect(outgoing).not.toHaveProperty("stream");
    const blocked = await call(body, { "x-relay-local-only": "1" });
    expect(blocked.response.status).toBe(412);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
});
