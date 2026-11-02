const FORWARDED = new Set([
  "retry-after", "x-should-retry", "x-relay-cache", "x-relay-policy-mode",
  "x-relay-policy-revision", "x-relay-upstream-requests", "x-relay-billable-tokens", "x-relay-usage-source",
]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";

export function upstreamResponseHeaders(headers) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) out[key] = value;
  });
  return out;
}
