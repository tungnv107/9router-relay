import { collectGeminiToolOutputText } from "../../../utils/geminiToolOutput.js";
import { ANTIGRAVITY_POLICY } from "../../../config/antigravityRelay.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const plainContent = value => onlyKeys(value, ["role", "parts"]) &&
  (value.role === undefined || ["user", "model", "system"].includes(value.role)) &&
  Array.isArray(value.parts) && value.parts.length > 0 &&
  value.parts.every(part => onlyKeys(part, ["text"]) && typeof part.text === "string");

export function antigravityEligibility(body) {
  const request = body.request;
  if (!onlyKeys(body, ANTIGRAVITY_POLICY.envelopeFields) || !onlyKeys(request, ANTIGRAVITY_POLICY.requestFields)) return "google_tools_state_or_unknown_field";
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length)) return "tools_or_state";
  if (!Array.isArray(request.contents) || !request.contents.length || !request.contents.every(plainContent)) return "non_text_or_tool_history";
  if (request.systemInstruction !== undefined && !plainContent(request.systemInstruction)) return "non_text_system_instruction";
  const generation = request.generationConfig;
  if (generation !== undefined && !onlyKeys(generation, ANTIGRAVITY_POLICY.generationFields)) return "unknown_generation_field";
  if (generation?.thinkingConfig !== undefined && !onlyKeys(generation.thinkingConfig, ANTIGRAVITY_POLICY.thinkingFields)) return "unknown_thinking_field";
  return null;
}

export function antigravityCacheBody(body) {
  // The IDE request ID contains a timestamp. It is transport metadata, not
  // generation input; all session, project, model and generation data stay keyed.
  const { requestId: _requestId, ...content } = body;
  return JSON.stringify(content);
}

function optimizeThinking(body, headers, config, changes) {
  const rule = config.reasoning.antigravityModels?.[body.model];
  if (!rule) return;
  const request = body.request;
  if (request.generationConfig !== undefined && !record(request.generationConfig)) return;
  const generation = request.generationConfig || {};
  if (generation.thinkingConfig !== undefined && !record(generation.thinkingConfig)) return;
  const thinking = generation.thinkingConfig || {};
  const alternate = rule.field === "thinkingBudget" ? "thinkingLevel" : "thinkingBudget";
  // Never invent a conversion between a numeric budget and a model's level.
  if (Object.hasOwn(thinking, alternate)) return;
  const current = thinking[rule.field];
  let next = current;
  if (current === undefined) next = rule.defaultValue;
  else if (rule.allowExplicitDowngrade && headers.get("x-relay-reasoning") === "allow-downgrade" && rule.maxValue !== undefined) {
    if (rule.field === "thinkingBudget" && Number.isSafeInteger(current) && (current === -1 || current > rule.maxValue)) next = rule.maxValue;
    if (rule.field === "thinkingLevel" && typeof current === "string" && rule.supported.includes(current.toLowerCase()) &&
        rule.supported.indexOf(current.toLowerCase()) > rule.supported.indexOf(rule.maxValue)) next = rule.maxValue;
  }
  if (next !== undefined && next !== current) {
    request.generationConfig = { ...generation, thinkingConfig: { ...thinking, [rule.field]: next } };
    changes.push(current === undefined ? "google_thinking_default_set" : "google_thinking_capped");
  }
}

// Google payloads stay native: OpenAI prompt_cache_key and reasoning fields
// are not valid controls for this endpoint.
export function optimizeAntigravity(body, headers, config, changes, shorten) {
  const request = body.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return;
  if (config.context.deduplicateTools && Array.isArray(request.tools)) {
    for (const group of request.tools) {
      if (!Array.isArray(group?.functionDeclarations)) continue;
      const seen = new Set();
      group.functionDeclarations = group.functionDeclarations.filter(tool => {
        const key = JSON.stringify(tool);
        if (seen.has(key)) { changes.push("duplicate_tool_removed"); return false; }
        seen.add(key);
        return true;
      });
    }
  }
  if (config.context.maxToolOutputChars && headers.get("x-relay-context") === "truncate-tool-output") {
    for (const { object, key, text } of collectGeminiToolOutputText(body) || []) object[key] = shorten(text);
  }
  optimizeThinking(body, headers, config, changes);
}
