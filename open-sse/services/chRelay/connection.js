import { Agent, fetch as directFetch } from "undici";
import { CH_RELAY_CONNECTION } from "../../config/chRelay.js";

export const DEFAULT_CH_RELAY_URL = CH_RELAY_CONNECTION.defaultUrl;
// A dedicated direct dispatcher keeps local credentials off environment proxies.
const dispatcher = new Agent({ connect: { timeout: CH_RELAY_CONNECTION.connectTimeoutMs } });

function allowedOrigins() {
  return (process.env.CH_RELAY_ALLOWED_ORIGINS || "").split(",").filter(v => v.trim()).map(value => {
    const url = new URL(value.trim());
    if (!CH_RELAY_CONNECTION.protocols.includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/" || url.hostname.includes("*")) {
      throw new Error("CH_RELAY_ALLOWED_ORIGINS must contain exact HTTP(S) origins only");
    }
    return url.origin;
  });
}

export function resolveChRelayBaseUrl(value) {
  const url = new URL(value || process.env.CH_RELAY_BASE_URL || DEFAULT_CH_RELAY_URL);
  if (!CH_RELAY_CONNECTION.protocols.includes(url.protocol) ||
      (!CH_RELAY_CONNECTION.loopbackHosts.includes(url.hostname) && !allowedOrigins().includes(url.origin)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("ch-relay requires loopback or an operator-approved CH_RELAY_ALLOWED_ORIGINS origin, without credentials, query or fragment");
  }
  // Pin localhost instead of resolving an arbitrary hosts-file entry.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/v1") throw new Error("ch-relay Base URL must end in /v1 (or use the host only)");
  url.pathname = "/v1";
  return url.href.replace(/\/$/, "");
}

export function chRelayFetch(url, init = {}) {
  // Validate every transport call, including probes. Never follow a redirect with a bearer token.
  const target = new URL(url);
  resolveChRelayBaseUrl(target.origin);
  return directFetch(target, { ...init, dispatcher, redirect: "error" });
}

export function codexRelayCredentials(credentials) {
  return {
    ...credentials,
    apiKey: undefined,
    accessToken: credentials?.accessToken || credentials?.apiKey,
    providerSpecificData: {
      ...credentials?.providerSpecificData,
      // Codex accounts inherit the server's relay, never an account's upstream URL.
      baseUrl: resolveChRelayBaseUrl(),
    },
  };
}

export function chRelayHeaders(credentials, stream = false) {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token || /\s/.test(token)) throw new Error("A ch-relay share key or ChatGPT access token is required");
  const headers = new Headers({
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${token}`,
  });
  const accountId = credentials?.providerSpecificData?.workspaceId ||
    credentials?.providerSpecificData?.chatgptAccountId || credentials?.providerSpecificData?.accountId;
  if (accountId) headers.set("chatgpt-account-id", accountId);
  return headers;
}

export async function probeChRelay(credentials) {
  try {
    const base = resolveChRelayBaseUrl(credentials?.providerSpecificData?.baseUrl);
    const response = await chRelayFetch(`${base}/models`, {
      headers: chRelayHeaders(credentials), signal: AbortSignal.timeout(CH_RELAY_CONNECTION.connectTimeoutMs),
    });
    // Discovery verifies connectivity only; some relay versions expose /models without authentication.
    const body = await response.json().catch(() => null);
    const valid = response.ok && Array.isArray(body?.data);
    return { valid, error: valid ? null : `ch-relay model discovery failed (HTTP ${response.status})`, authenticationVerified: false };
  } catch {
    return { valid: false, error: "Cannot reach ch-relay. Check its URL, allowed origin, port and running proxy.", authenticationVerified: false };
  }
}
