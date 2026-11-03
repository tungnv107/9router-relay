import { ANTIGRAVITY_RELAY, antigravityRelayTarget } from "../../config/antigravityRelay.mjs";
import { chRelayFetch, resolveChRelayBaseUrl } from "./connection.js";
import { handleChRelayRequest } from "./transport.js";
import { applyRelayControls } from "./controls.js";
import { getChRelayPolicy } from "./runtime.js";

export function antigravityRelayUrl(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const base = new URL(resolveChRelayBaseUrl());
  const url = `${base.origin}${ANTIGRAVITY_RELAY.prefix}${upstream.pathname}${upstream.search}`;
  if (upstream.origin !== ANTIGRAVITY_RELAY.upstreamOrigin || upstream.username || upstream.password || upstream.hash || !antigravityRelayTarget(url)) {
    throw new Error("Unsupported Antigravity relay endpoint");
  }
  return url;
}

export function antigravityRelayHeaders(credentials, original = {}, policy = getChRelayPolicy()) {
  const token = credentials?.accessToken;
  if (!token || /\s/.test(token)) throw new Error("A Google OAuth access token is required for Antigravity");
  const headers = new Headers();
  const source = new Headers(original);
  for (const name of ANTIGRAVITY_RELAY.requestHeaders) {
    if (source.has(name)) headers.set(name, source.get(name));
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  return applyRelayControls(headers, credentials, policy || getChRelayPolicy());
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
  // Apply native Google replay/context/thinking policy before network transport.
  return handleChRelayRequest(request, async outgoing => fetchImpl(target.href, {
    method: "POST", headers: outgoing.headers, body: await outgoing.text(),
    signal: outgoing.signal, redirect: "error",
  }), policy);
}
