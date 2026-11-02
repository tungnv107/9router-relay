import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRelayExecutor } from "../../open-sse/executors/codex-relay.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";

describe("Codex OAuth automatically uses ch-relay over real HTTP", () => {
  let server, base, requests, executor, status;
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Relay unavailable" } }));
      } else if (req.url.endsWith("/compact")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "compact-state" }] }));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[]}}\n\n');
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}/v1`;
  });
  beforeEach(() => {
    requests = [];
    status = 200;
    vi.stubEnv("CH_RELAY_BASE_URL", base);
    vi.stubEnv("CH_RELAY_ALLOWED_ORIGINS", "");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected direct upstream call"));
    executor = new CodexRelayExecutor({ policy: new PolicyEngine({ readConfig: () => chRelayDefaults }) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const args = (overrides = {}) => ({
    model: "gpt-6-luna", body: { input: "Reply RELAY_OK" }, stream: true,
    credentials: { accessToken: "codex-oauth-token", connectionId: "existing-codex-connection" },
    ...overrides,
  });

  it("registers the automatic transport for existing Codex connections", () => {
    expect(getExecutor("codex")).toBeInstanceOf(CodexRelayExecutor);
    expect(getExecutor("codex").getProvider()).toBe("codex");
  });

  it("needs only the existing OAuth token and forwards Responses Lite identity", async () => {
    const result = await executor.execute(args());
    expect(result.url).toBe(`${base}/responses`);
    expect(await result.response.text()).toContain("response.completed");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toMatchObject({ authorization: "Bearer codex-oauth-token", "x-openai-internal-codex-responses-lite": "true", originator: "codex_cli_rs" });
    expect(requests[0].body).toMatchObject({ model: "gpt-6-luna", stream: true, store: false });
    expect(requests[0].body.input[0].type).toBe("additional_tools");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ chatgptAccountId: "account-a" }, "account-a"],
    [{ workspaceId: "workspace-a", chatgptAccountId: "account-a" }, "workspace-a"],
    [{ accountId: "legacy-a" }, "legacy-a"],
  ])("inherits account binding %j", async (providerSpecificData, accountId) => {
    const result = await executor.execute(args({ credentials: { accessToken: "token", providerSpecificData } }));
    await result.response.text();
    expect(requests[0].headers["chatgpt-account-id"]).toBe(accountId);
  });

  it("uses the current access token and server URL, without changing stored connection data", async () => {
    const credentials = { accessToken: "fresh-token", apiKey: "stale-key", providerSpecificData: { baseUrl: "https://untrusted.example/v1" },
      rawHeaders: { authorization: "Bearer router-client-key", "chatgpt-account-id": "forged-account" } };
    const original = structuredClone(credentials);
    const result = await executor.execute(args({ credentials }));
    await result.response.text();
    expect(result.url).toBe(`${base}/responses`);
    expect(requests[0].headers.authorization).toBe("Bearer fresh-token");
    expect(requests[0].headers["chatgpt-account-id"]).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("router-client-key");
    expect(credentials).toEqual(original);
  });

  it("preserves encrypted reasoning, tool IDs, custom tools and session headers", async () => {
    const input = [{ type: "reasoning", encrypted_content: "opaque-state" }, { type: "function_call_output", call_id: "call-a", output: "TOOL_OK" }];
    const tools = [{ type: "custom", name: "patch", format: { type: "text" } }];
    const result = await executor.execute(args({ model: "gpt-6-astra", body: { input, tools, prompt_cache_key: "stable-key" },
      credentials: { accessToken: "token", rawHeaders: { session_id: "session-a", "x-codex-turn-state": "turn-a" } } }));
    await result.response.text();
    expect(requests[0].body).toMatchObject({ input, tools, prompt_cache_key: "stable-key" });
    expect(requests[0].headers).toMatchObject({ session_id: "session-a", "x-codex-turn-state": "turn-a" });
    expect(requests[0].headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });

  it("uses the upstream model ID for virtual review models", async () => {
    const result = await executor.execute(args({ model: "gpt-5.6-sol-review", body: { input: "Review this" } }));
    await result.response.text();
    expect(requests[0].body.model).toBe("gpt-5.6-sol");
  });

  it("keeps compact endpoint on repeated calls and removes internal flags", async () => {
    const request = args({ body: { _compact: true, input: "Compact this" } });
    for (let i = 0; i < 2; i++) {
      const result = await executor.execute(request);
      expect((await result.response.json()).object).toBe("response.compaction");
      expect(requests[i].url).toBe("/v1/responses/compact");
      expect(requests[i].body).not.toHaveProperty("stream");
      expect(requests[i].body).not.toHaveProperty("_compact");
    }
    expect(request.body._compact).toBe(true);
  });

  it.each([401, 429, 503])("returns relay HTTP %s without direct fallback", async code => {
    status = code;
    const result = await executor.execute(args());
    expect(result.response.status).toBe(code);
    await result.response.text();
    expect(requests).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not bypass a relay transport failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Relay offline"));
    executor = new CodexRelayExecutor({ fetchImpl });
    await expect(executor.execute(args())).rejects.toThrow("Relay offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["kill", "local-only"])("enforces %s without a network request", async guard => {
    executor = new CodexRelayExecutor({ policy: new PolicyEngine({ readConfig: () => ({ ...chRelayDefaults, ...(guard === "kill" ? { killSwitch: "block" } : {}) }) }) });
    const result = await executor.execute(args({ credentials: { accessToken: "token", rawHeaders: { "x-relay-local-only": "1" } } }));
    expect(result.response.status).toBe(guard === "kill" ? 503 : 412);
    expect(result.response.headers.get("x-relay-upstream-requests")).toBe("0");
    await result.response.text();
    expect(requests).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unapproved relay origin before sending the OAuth token", async () => {
    vi.stubEnv("CH_RELAY_BASE_URL", "https://untrusted.example/v1");
    await expect(executor.execute(args())).rejects.toThrow("operator-approved");
    expect(requests).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
