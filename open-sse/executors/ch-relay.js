import { createHmac } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { chRelayFetch, chRelayHeaders, resolveChRelayBaseUrl } from "../services/chRelay/connection.js";
import { getChRelayPolicy } from "../services/chRelay/runtime.js";
import { assertDirectChRelay, handleChRelayRequest } from "../services/chRelay/transport.js";

const CONTROL_HEADERS = ["x-relay-cache", "x-relay-cache-scope", "x-relay-local-only", "x-relay-context", "x-relay-reasoning", "cache-control"];
const SESSION_HEADERS = ["originator", "session_id", "conversation_id", "x-codex-turn-state", "x-codex-turn-metadata"];

export class ChRelayExecutor extends BaseExecutor {
  constructor({ fetchImpl = chRelayFetch, policy = null } = {}) {
    super("ch-relay", PROVIDERS["ch-relay"]);
    this.fetchImpl = fetchImpl;
    this.policy = policy;
  }

  async execute({ model, body, stream, credentials, signal, proxyOptions, requestHeaders }) {
    assertDirectChRelay(proxyOptions);
    const base = resolveChRelayBaseUrl(credentials?.providerSpecificData?.baseUrl);
    const format = credentials?.runtimeTransport?.format || (body.input !== undefined ? "openai-responses" : "openai");
    const compact = body._compact === true && format === "openai-responses";
    const endpoint = compact ? "/v1/responses/compact" : format === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
    const url = `${base}${endpoint.slice(3)}`;
    const headers = new Headers(requestHeaders || {});
    // Connection credentials always win over caller/custom headers.
    for (const [name, value] of chRelayHeaders(credentials, stream)) headers.set(name, value);
    const rawHeaders = new Headers(credentials?.rawHeaders || {});
    for (const name of [...CONTROL_HEADERS, ...SESSION_HEADERS]) {
      if (rawHeaders.has(name)) headers.set(name, rawHeaders.get(name));
    }
    const policy = this.policy || getChRelayPolicy();
    // Isolate callers even when 9router shares one relay credential among many API keys.
    // These HMAC-only internal headers are removed by the policy before network transport.
    headers.set("x-relay-principal", createHmac("sha256", policy.secret)
      .update(JSON.stringify([rawHeaders.get("authorization"), rawHeaders.get("x-api-key"), credentials?.connectionId || null])).digest("hex"));
    if (rawHeaders.has("cookie") || rawHeaders.has("idempotency-key")) headers.set("x-relay-cache", "bypass");
    // Respect 9router's existing per-request opt-out without weakening local-only/kill guards.
    if (rawHeaders.get("x-9router-token-saver")?.toLowerCase() === "off") {
      headers.set("x-relay-cache", "bypass");
      headers.set("x-relay-optimizer", "off");
    }
    let transformedBody = { ...body, model, stream };
    delete transformedBody._compact;
    if (compact) delete transformedBody.stream;
    const request = new Request(url, { method: "POST", headers, body: JSON.stringify(transformedBody), signal });
    const response = await handleChRelayRequest(request, async (outgoing) => {
      transformedBody = await outgoing.json();
      return this.fetchImpl(url, {
        method: "POST", headers: outgoing.headers, body: JSON.stringify(transformedBody),
        signal: outgoing.signal, redirect: "error",
      });
    }, policy);
    return { response, url, headers: Object.fromEntries(headers), transformedBody, responseFormat: format };
  }
}
