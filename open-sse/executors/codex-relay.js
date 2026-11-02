import { CodexExecutor } from "./codex.js";
import { ChRelayExecutor } from "./ch-relay.js";
import { codexRelayCredentials } from "../services/chRelay/connection.js";
import { FORMATS } from "../translator/formats.js";

// Keep the existing Codex connection/account lifecycle; only inference transport changes.
export class CodexRelayExecutor extends CodexExecutor {
  constructor(options) {
    super();
    this.relay = new ChRelayExecutor(options);
  }

  async executeRequest(args) {
    const compact = args.body._compact === true;
    // Normalization mutates its input. Preserve the original for auth/SSE retries,
    // especially the compact flag and Responses Lite tool prefix.
    const body = this.transformRequest(args.model, structuredClone(args.body), args.stream, args.credentials);
    const requestHeaders = {
      ...this.buildHeaders(args.credentials, !compact, null, body.model, body),
      ...args.providerOverrides?.headers,
    };
    return this.relay.execute({
      ...args,
      model: body.model,
      body: compact ? { ...body, _compact: true } : body,
      stream: !compact,
      requestHeaders,
      credentials: {
        ...codexRelayCredentials(args.credentials),
        runtimeTransport: { format: FORMATS.OPENAI_RESPONSES },
      },
    });
  }
}
