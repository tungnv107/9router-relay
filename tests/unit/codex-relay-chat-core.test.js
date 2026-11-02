import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { CodexRelayExecutor } from "../../open-sse/executors/codex-relay.js";
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
const response = { id: "resp-fixture", object: "response", status: "completed", model: "gpt-6-astra",
  output: [{ id: "msg-fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "AUTO_RELAY_OK", annotations: [] }] }],
  usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } };
const sse = () => new Response([
  { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  { type: "response.output_item.done", output_index: 0, item: response.output[0] },
  { type: "response.completed", response },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const call = (body, extra = {}) => handleChatCore({
  body: structuredClone(body), modelInfo: { provider: "codex", model: "gpt-6-astra" },
  credentials: { accessToken: "oauth-token", refreshToken: "refresh-token", connectionId: "existing-codex", providerSpecificData: { chatgptAccountId: "account-a" } },
  connectionId: "existing-codex", log: { debug() {}, info() {}, warn() {}, error() {} },
  clientRawRequest: { endpoint: body.input ? "/v1/responses" : "/v1/chat/completions", body, headers: { authorization: "Bearer router-key" } },
  ...extra,
});

describe("existing Codex connection through real chatCore and relay policy", () => {
  beforeEach(() => {
    vi.stubEnv("CH_RELAY_BASE_URL", "http://127.0.0.1:11500/v1");
    state.fetch.mockReset().mockImplementation(sse);
    state.executor = new CodexRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => chRelayDefaults }) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(["chat", "responses"])("translates %s to the relay and returns exact JSON usage", async format => {
    const body = { model: "cx/gpt-6-astra", stream: false, ...(format === "chat" ? { messages: [{ role: "user", content: "Reply AUTO_RELAY_OK" }] } : { input: "Reply AUTO_RELAY_OK" }) };
    const result = await call(body);
    expect(result.success).toBe(true);
    const data = await result.response.json();
    expect(JSON.stringify(data)).toContain("AUTO_RELAY_OK");
    expect(data.usage.total_tokens).toBe(14);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = state.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11500/v1/responses");
    expect(init.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(init.headers.get("chatgpt-account-id")).toBe("account-a");
    expect(JSON.parse(init.body).model).toBe("gpt-6-astra");
  });

  it.each(["chat", "responses"])("streams %s through the relay without inventing usage", async format => {
    const result = await call({ model: "cx/gpt-6-astra", stream: true,
      ...(format === "chat" ? { messages: [{ role: "user", content: "Reply" }], stream_options: { include_usage: true } } : { input: "Reply" }) });
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain('"total_tokens":14');
    expect(text).not.toContain('"total_tokens":2014');
  });

  it("refreshes an expired OAuth credential and retries the same relay with the new token", async () => {
    state.fetch.mockImplementationOnce(async () => Response.json({ error: { message: "Expired token" } }, { status: 401 }));
    const refresh = vi.spyOn(state.executor, "refreshCredentials").mockResolvedValue({ accessToken: "fresh-token", refreshToken: "rotated-refresh" });
    const persisted = vi.fn();
    const result = await call({ model: "cx/gpt-6-astra", input: "Reply", stream: false }, { onCredentialsRefreshed: persisted });
    expect(result.success).toBe(true);
    await result.response.text();
    expect(refresh).toHaveBeenCalledOnce();
    expect(persisted).toHaveBeenCalledWith({ accessToken: "fresh-token", refreshToken: "rotated-refresh" });
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.fetch.mock.calls[1][0]).toBe(state.fetch.mock.calls[0][0]);
    expect(state.fetch.mock.calls[1][1].headers.get("authorization")).toBe("Bearer fresh-token");
  });

  it("returns compact JSON with its encrypted state intact", async () => {
    state.fetch.mockImplementation(async () => Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "compact-state" }] }));
    const result = await call({ model: "cx/gpt-6-astra", _compact: true, input: "Compact" });
    expect(result.success).toBe(true);
    expect((await result.response.json()).output[0].encrypted_content).toBe("compact-state");
    expect(state.fetch.mock.calls[0][0]).toMatch(/\/responses\/compact$/);
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).not.toHaveProperty("stream");
  });

  it("preserves local policy errors so the router will not rotate accounts", async () => {
    state.executor = new CodexRelayExecutor({ fetchImpl: state.fetch, policy: new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, killSwitch: "block" }) }) });
    const result = await call({ model: "cx/gpt-6-astra", input: "Reply", stream: false });
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("x-relay-upstream-requests")).toBe("0");
    await result.response.text();
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
