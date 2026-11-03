// Bun preload for the packaged-backend smoke test. Never calls the public network.
import assert from "node:assert/strict";
import { ANTIGRAVITY_RELAY } from "../../open-sse/config/antigravityRelay.mjs";
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  assert.equal(target.origin, ANTIGRAVITY_RELAY.upstreamOrigin, "Unexpected public network request");
  assert.equal(options.proxy, "");
  assert.equal(options.redirect, "error");
  return nativeFetch(`${process.env.GOOGLE_FIXTURE_ORIGIN}${target.pathname}${target.search}`, options);
};
