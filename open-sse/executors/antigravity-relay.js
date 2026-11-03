import { AntigravityExecutor } from "./antigravity.js";
import { ANTIGRAVITY_RELAY } from "../config/antigravityRelay.mjs";
import { antigravityRelayHeaders, antigravityRelayUrl, fetchAntigravityRelay } from "../services/chRelay/antigravity.js";
import { assertDirectChRelay } from "../services/chRelay/transport.js";

// Preserve Google protocol conversion, retries and OAuth refresh in 9router.
export class AntigravityRelayExecutor extends AntigravityExecutor {
  constructor(options = {}) {
    super();
    this.relayOptions = options;
  }

  buildUrl(model, stream) {
    return antigravityRelayUrl(super.buildUrl(model, stream));
  }

  getFallbackCount() { return 1; }

  buildHeaders(credentials, stream) {
    return Object.fromEntries(antigravityRelayHeaders(credentials, super.buildHeaders(credentials, stream)));
  }

  transformRequest(model, body, stream, credentials) {
    return super.transformRequest(model, structuredClone(body), stream, credentials);
  }

  fetchRequest(url, options) {
    return fetchAntigravityRelay(url, options, this.relayOptions);
  }

  computeRetryDelay(response, ...args) {
    if (response.headers.get("x-relay-upstream-requests") === "0") return false;
    return super.computeRetryDelay(response, ...args);
  }

  execute(args) {
    assertDirectChRelay(args.proxyOptions);
    const overrides = new Headers(args.providerOverrides?.headers || {});
    const headers = Object.fromEntries([...overrides].filter(([name]) => ANTIGRAVITY_RELAY.overrideHeaders.includes(name)));
    return super.execute({ ...args, providerOverrides: { headers } });
  }
}
