export const CH_RELAY_CONNECTION = Object.freeze({
  defaultUrl: "http://127.0.0.1:11500/v1",
  protocols: ["http:", "https:"],
  loopbackHosts: ["127.0.0.1", "localhost", "[::1]"],
  connectTimeoutMs: 10_000,
});

export function usesChRelay(provider) {
  return provider === "ch-relay" || provider === "codex";
}
