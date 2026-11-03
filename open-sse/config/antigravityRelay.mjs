// Shared by 9router and the standalone ch-relay Google transport.
export const ANTIGRAVITY_RELAY = Object.freeze({
  prefix: "/v1/antigravity",
  upstreamOrigin: "https://daily-cloudcode-pa.googleapis.com",
  generatePath: "/v1internal:generateContent",
  streamPath: "/v1internal:streamGenerateContent",
  streamQuery: "?alt=sse",
  requestHeaders: Object.freeze(["authorization", "content-type", "user-agent", "x-goog-api-client", "x-goog-user-project"]),
  overrideHeaders: Object.freeze(["user-agent", "x-goog-api-client", "x-goog-user-project"]),
  maxRequestBytes: 128 * 1024 * 1024,
  connectTimeoutMs: 60_000,
});

// Conservative replay contract: unknown/stateful fields always go upstream.
export const ANTIGRAVITY_POLICY = Object.freeze({
  envelopeFields: ["model", "project", "userAgent", "requestId", "request"],
  requestFields: ["contents", "systemInstruction", "generationConfig", "sessionId", "tools", "safetySettings"],
  generationFields: ["temperature", "topP", "topK", "candidateCount", "maxOutputTokens", "stopSequences", "seed", "responseMimeType", "responseSchema", "responseJsonSchema", "thinkingConfig", "presencePenalty", "frequencyPenalty"],
  thinkingFields: ["includeThoughts", "thinkingBudget", "thinkingLevel"],
  thinkingLevels: ["minimal", "low", "medium", "high"],
  maxThinkingBudget: 1_000_000,
  responseFields: ["candidates", "usageMetadata", "modelVersion", "responseId", "createTime"],
  candidateFields: ["content", "finishReason", "index", "safetyRatings", "tokenCount"],
  usageFields: ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"],
  usageDetailFields: ["promptTokensDetails", "cacheTokensDetails", "candidatesTokensDetails", "toolUsePromptTokensDetails"],
});

export function isAntigravityEndpoint(endpoint) {
  return [ANTIGRAVITY_RELAY.generatePath, ANTIGRAVITY_RELAY.streamPath]
    .some(path => endpoint === ANTIGRAVITY_RELAY.prefix + path);
}

// Exact paths and queries only: callers cannot choose another upstream or API.
export function antigravityRelayTarget(url) {
  const target = new URL(url);
  const path = target.pathname.slice(ANTIGRAVITY_RELAY.prefix.length);
  if (!target.pathname.startsWith(ANTIGRAVITY_RELAY.prefix) || target.hash) return null;
  if (path === ANTIGRAVITY_RELAY.generatePath && !target.search ||
      path === ANTIGRAVITY_RELAY.streamPath && target.search === ANTIGRAVITY_RELAY.streamQuery) {
    return `${ANTIGRAVITY_RELAY.upstreamOrigin}${path}${target.search}`;
  }
  return null;
}
