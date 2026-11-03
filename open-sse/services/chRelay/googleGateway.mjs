import { ANTIGRAVITY_RELAY, antigravityRelayTarget } from "../../config/antigravityRelay.mjs";

const excludedResponseHeaders = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding",
  "proxy-authenticate", "proxy-authorization", "upgrade", "trailer", "te", "set-cookie", "location",
]);

function localError(status, message, upstreamRequests = "0") {
  return Response.json({ error: { code: status, message, status: "RELAY_ERROR" } }, {
    status, headers: { "cache-control": "no-store", "x-relay-upstream-requests": upstreamRequests },
  });
}

async function readBody(request, maxBytes) {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

// This handler is installed only on the private inference server. Google validates
// the bearer credential; refresh tokens/client secrets stay in 9router.
export function createAntigravityHandler({ fetchImpl = globalThis.fetch, maxRequestBytes = ANTIGRAVITY_RELAY.maxRequestBytes } = {}) {
  return async request => {
    const target = antigravityRelayTarget(request.url);
    if (!target) return localError(404, "Unknown Antigravity relay endpoint");
    if (request.method !== "POST") return localError(405, "Antigravity requires POST");
    if (!/^Bearer [^\s]+$/i.test(request.headers.get("authorization") || "")) {
      return localError(401, "A Google OAuth bearer access token is required");
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return localError(415, "Antigravity requires application/json");
    }
    if (request.headers.get("x-relay-local-only") === "1") return localError(412, "Antigravity has no local response cache");

    let body;
    try {
      body = await readBody(request, maxRequestBytes);
      if (!body) return localError(413, "Antigravity request exceeds the body limit");
      const parsed = JSON.parse(new TextDecoder().decode(body));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return localError(400, "Expected a JSON object");
    } catch {
      return localError(request.signal.aborted ? 499 : 400, "Invalid or cancelled Antigravity request");
    }
    if (request.signal.aborted) return localError(499, "Antigravity request cancelled");

    const headers = new Headers();
    for (const name of ANTIGRAVITY_RELAY.requestHeaders) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new Error("Google response header timeout")), ANTIGRAVITY_RELAY.connectTimeoutMs);
    timer.unref?.();
    let upstream;
    try {
      // Bun's empty proxy setting prevents environment proxies receiving the token.
      // The URL comes exclusively from our fixed route table, never request data.
      upstream = await fetchImpl(target, { method: "POST", headers, body, signal, proxy: "", redirect: "error" });
    } catch {
      return localError(request.signal.aborted ? 499 : controller.signal.aborted ? 504 : 502, "Antigravity upstream connection failed", "1");
    } finally { clearTimeout(timer); }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return localError(502, "Antigravity upstream redirect refused", "1");
    }
    const responseHeaders = new Headers(upstream.headers);
    for (const name of [...responseHeaders.keys()]) {
      if (excludedResponseHeaders.has(name) || name.startsWith("x-relay-")) responseHeaders.delete(name);
    }
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-relay-upstream-requests", "1");
    if (!upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders });
    const reader = upstream.body.getReader();
    return new Response(new ReadableStream({
      async pull(stream) {
        try {
          const part = await reader.read();
          if (part.done) stream.close(); else stream.enqueue(part.value);
        } catch (error) { stream.error(error); }
      },
      async cancel(reason) { controller.abort(reason); await reader.cancel(reason); },
    }), { status: upstream.status, headers: responseHeaders });
  };
}

export function withAntigravityRoutes(options, dependencies) {
  const handle = createAntigravityHandler(dependencies);
  return { ...options, routes: {
    ...options.routes,
    [ANTIGRAVITY_RELAY.prefix]: handle,
    [`${ANTIGRAVITY_RELAY.prefix}/*`]: handle,
  } };
}

export function withAntigravityNetworkPolicy(openai) {
  return {
    ...openai,
    allowedOrigins: [...openai.allowedOrigins, ANTIGRAVITY_RELAY.upstreamOrigin],
    providerOrigins: { openai: openai.allowedOrigins, antigravity: [ANTIGRAVITY_RELAY.upstreamOrigin] },
    antigravity: {
      authentication: "google-oauth-access-token", oauthManagedBy: "9router",
      endpoints: [ANTIGRAVITY_RELAY.generatePath, ANTIGRAVITY_RELAY.streamPath + ANTIGRAVITY_RELAY.streamQuery],
    },
  };
}
