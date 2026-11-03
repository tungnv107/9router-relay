import { describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_RELAY } from "../../open-sse/config/antigravityRelay.mjs";
import { createAntigravityHandler, withAntigravityNetworkPolicy } from "../../open-sse/services/chRelay/googleGateway.mjs";

const url = "http://127.0.0.1:11500/v1/antigravity/v1internal:generateContent";
const request = (options = {}, target = url) => new Request(target, {
  method: "POST", headers: { authorization: "Bearer google-token", "content-type": "application/json" }, body: '{"project":"test-project","model":"fixture","request":{}}', ...options,
});

describe("private ch-relay Google protocol handler", () => {
  it("forwards tools, thought signatures and JSON bytes without OpenAI translation", async () => {
    const body = JSON.stringify({ project: "test-project", model: "fixture", request: { contents: [{ role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "x" } }, thoughtSignature: "opaque-signature" }] }], tools: [{ functionDeclarations: [{ name: "read_file" }] }] } });
    const fetchImpl = vi.fn(async () => Response.json({ response: { usageMetadata: { totalTokenCount: 14 } } }));
    const response = await createAntigravityHandler({ fetchImpl })(request({ body }));
    expect(response.status).toBe(200);
    const [target, init] = fetchImpl.mock.calls[0];
    expect(target).toBe(ANTIGRAVITY_RELAY.upstreamOrigin + ANTIGRAVITY_RELAY.generatePath);
    expect(new TextDecoder().decode(init.body)).toBe(body);
    expect(init.redirect).toBe("error");
    expect(init.proxy).toBe("");
    expect(init.headers.get("authorization")).toBe("Bearer google-token");
    expect(await response.json()).toEqual({ response: { usageMetadata: { totalTokenCount: 14 } } });
  });

  it.each([
    ["/v1/antigravity/v1internal:loadCodeAssist", 404],
    ["/v1/antigravity/token", 404],
    ["/v1/antigravity/v1internal:generateContent?url=https://evil.example", 404],
    ["/v1/antigravity/v1internal:generateContent?access_token=secret", 404],
    ["/v1/antigravity/v1internal:streamGenerateContent?alt=sse&alt=json", 404],
    ["/v1/antigravity/https://evil.example", 404],
  ])("rejects arbitrary targets and query credentials: %s", async (path, status) => {
    const fetchImpl = vi.fn();
    expect((await createAntigravityHandler({ fetchImpl })(request({}, `http://localhost${path}`))).status).toBe(status);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{ headers: { "content-type": "application/json" } }, 401],
    [{ headers: { authorization: "Basic private", "content-type": "application/json" } }, 401],
    [{ headers: { authorization: "Bearer token", "content-type": "text/plain" } }, 415],
    [{ method: "GET", body: undefined }, 405],
    [{ body: "[1,2]" }, 400],
    [{ body: "invalid json" }, 400],
    [{ headers: { authorization: "Bearer token", "content-type": "application/json", "x-relay-local-only": "1" } }, 412],
  ])("rejects invalid input before network (%j)", async (options, status) => {
    const fetchImpl = vi.fn();
    const response = await createAntigravityHandler({ fetchImpl })(request(options));
    expect(response.status).toBe(status);
    expect(response.headers.get("x-relay-upstream-requests")).toBe("0");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds bodies even without content-length", async () => {
    const fetchImpl = vi.fn();
    const response = await createAntigravityHandler({ fetchImpl, maxRequestBytes: 10 })(request());
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards only Google headers and strips response cookies and decompression metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { headers: { "set-cookie": "private", "content-encoding": "gzip", "content-length": "99", "x-relay-cache": "hit", "retry-after": "12", "x-goog-quota": "quota" } }));
    const response = await createAntigravityHandler({ fetchImpl })(request({ headers: {
      authorization: "Bearer google-token", "content-type": "application/json", cookie: "session", "x-api-key": "router-key", "chatgpt-account-id": "account", "x-relay-target": "https://evil.example", "x-goog-user-project": "billing-project",
    } }));
    const headers = fetchImpl.mock.calls[0][1].headers;
    for (const name of ["cookie", "x-api-key", "chatgpt-account-id", "x-relay-target"]) expect(headers.has(name)).toBe(false);
    expect(headers.get("x-goog-user-project")).toBe("billing-project");
    for (const name of ["set-cookie", "content-length", "content-encoding", "x-relay-cache"]) expect(response.headers.has(name)).toBe(false);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("x-goog-quota")).toBe("quota");
    await response.text();
  });

  it("streams before completion and propagates response cancellation upstream", async () => {
    const cancelled = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await createAntigravityHandler({ fetchImpl })(request({}, url.replace("generateContent", "streamGenerateContent?alt=sse")));
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await reader.cancel("client left");
    expect(cancelled).toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("returns Google authentication errors intact", async () => {
    const error = { error: { code: 401, status: "UNAUTHENTICATED", message: "Expired access token" } };
    const response = await createAntigravityHandler({ fetchImpl: async () => Response.json(error, { status: 401 }) })(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(error);
  });

  it("refuses redirects and hides credential-bearing transport errors", async () => {
    for (const fetchImpl of [async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }), async () => { throw new Error("private-token"); }]) {
      const response = await createAntigravityHandler({ fetchImpl })(request());
      expect(response.status).toBe(502);
      expect(response.headers.has("location")).toBe(false);
      expect(await response.text()).not.toContain("private-token");
    }
  });

  it("reports separate fixed OpenAI and Google origins", () => {
    const policy = withAntigravityNetworkPolicy({ enforced: true, allowedOrigins: ["https://chatgpt.com", "https://auth.openai.com"], vendorServices: false });
    expect(policy.allowedOrigins).toHaveLength(3);
    expect(policy.providerOrigins.antigravity).toEqual([ANTIGRAVITY_RELAY.upstreamOrigin]);
    expect(policy.vendorServices).toBe(false);
  });
});
