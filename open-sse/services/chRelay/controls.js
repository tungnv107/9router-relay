import { createHmac } from "node:crypto";

const CONTROL_HEADERS = ["x-relay-cache", "x-relay-cache-scope", "x-relay-local-only", "x-relay-context", "x-relay-reasoning", "x-relay-optimizer", "cache-control"];

// Identical isolation and opt-out semantics for OpenAI and native Google.
// The policy removes every x-relay-* header before network transport.
export function applyRelayControls(headers, credentials, policy) {
  const raw = new Headers(credentials?.rawHeaders || {});
  for (const name of CONTROL_HEADERS) if (raw.has(name)) headers.set(name, raw.get(name));
  headers.set("x-relay-principal", createHmac("sha256", policy.secret)
    .update(JSON.stringify([raw.get("authorization"), raw.get("x-api-key"), credentials?.connectionId || null])).digest("hex"));
  if (raw.has("cookie") || raw.has("idempotency-key")) headers.set("x-relay-cache", "bypass");
  if (raw.get("x-9router-token-saver")?.toLowerCase() === "off") {
    headers.set("x-relay-cache", "bypass");
    headers.set("x-relay-optimizer", "off");
  }
  return headers;
}
