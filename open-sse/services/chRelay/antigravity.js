import { ANTIGRAVITY_RELAY, antigravityRelayTarget } from "../../config/antigravityRelay.mjs";
import { chRelayFetch, resolveChRelayBaseUrl } from "./connection.js";
import { handleChRelayRequest } from "./transport.js";

export function antigravityRelayUrl(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const base = new URL(resolveChRelayBaseUrl());
  const url = `${base.origin}${ANTIGRAVITY_RELAY.prefix}${upstream.pathname}${upstream.search}`;
  if (upstream.origin !== ANTIGRAVITY_RELAY.upstreamOrigin || upstream.username || upstream.password || upstream.hash || !antigravityRelayTarget(url)) {
    throw new Error("Unsupported Antigravity relay endpoint");
  }
  return url;
}

export function antigravityRelayHeaders(credentials, original = {}) {
  const token = credentials?.accessToken;
  if (!token || /\s/.test(token)) throw new Error("A Google OAuth access token is required for Antigravity");
  const headers = new Headers();
  const source = new Headers(original);
  for (const name of ANTIGRAVITY_RELAY.requestHeaders) {
    if (source.has(name)) headers.set(name, source.get(name));
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  const raw = new Headers(credentials?.rawHeaders || {});
  if (raw.has("x-relay-local-only")) headers.set("x-relay-local-only", raw.get("x-relay-local-only"));
  return headers;
}

export async function fetchAntigravityRelay(url, options, { fetchImpl = chRelayFetch, policy } = {}) {
  const target = new URL(url);
  const base = new URL(resolveChRelayBaseUrl());
  if (target.origin !== base.origin || target.username || target.password || !antigravityRelayTarget(target)) {
    throw new Error("Unsupported Antigravity relay endpoint");
  }
  const request = new Request(target, {
    method: "POST", headers: options.headers, body: options.body, signal: options.signal,
  });
  // The native Google endpoint bypasses OpenAI cache/optimizer transformations.
  // Policy still enforces kill, cancellation and local-only before any network call.
  return handleChRelayRequest(request, async outgoing => fetchImpl(target.href, {
    method: "POST", headers: outgoing.headers, body: await outgoing.text(),
    signal: outgoing.signal, redirect: "error",
  }), policy);
}
