import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChRelayExecutor } from "../../open-sse/executors/ch-relay.js";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";
import { chRelayFetch, probeChRelay } from "../../open-sse/services/chRelay/connection.js";

describe("ch-relay real HTTP transport", () => {
  let server, base, requests;
  beforeAll(async () => {
    requests = [];
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/redirect") { res.writeHead(307, { location: base + "/target" }).end(); return; }
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
      res.end(JSON.stringify({ id: "chatcmpl-http", object: "chat.completion", model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "HTTP_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it("probes models without sending inference", async () => {
    const result = await probeChRelay({ apiKey: "relay-key", providerSpecificData: { baseUrl: base } });
    expect(result).toMatchObject({ valid: true, authenticationVerified: false });
    expect(requests.at(-1).url).toBe("/v1/models");
  });

  it("uses direct loopback and proves replay makes zero HTTP requests", async () => {
    const policy = new PolicyEngine({ readConfig: () => chRelayDefaults });
    const executor = new ChRelayExecutor({ policy });
    const args = { model: "fixture", body: { messages: [{ role: "user", content: "Reply HTTP_OK" }] }, stream: false,
      credentials: { apiKey: "relay-key", providerSpecificData: { baseUrl: base }, rawHeaders: {
        authorization: "Bearer private-router-key", "x-relay-cache": "allow", "x-relay-cache-scope": "http-v1",
      } } };
    const before = requests.length;
    const first = await executor.execute(args);
    expect((await first.response.json()).usage.total_tokens).toBe(7);
    expect(requests.length - before).toBe(1);
    expect(requests.at(-1).headers.authorization).toBe("Bearer relay-key");
    expect(JSON.stringify(requests.at(-1))).not.toContain("private-router-key");
    args.credentials.rawHeaders["x-relay-local-only"] = "1";
    const hit = await executor.execute(args);
    expect(hit.response.headers.get("x-relay-cache")).toBe("hit");
    expect((await hit.response.json()).usage.total_tokens).toBe(0);
    expect(requests.length - before).toBe(1);
  });

  it("rejects redirects before forwarding the credential to a new target", async () => {
    const before = requests.length;
    await expect(chRelayFetch(`${base}/redirect`, { headers: { authorization: "Bearer redirect-secret" } })).rejects.toThrow();
    expect(requests.length - before).toBe(1);
    expect(requests.at(-1).url).toBe("/redirect");
  });
});
