import { collectGeminiToolOutputText } from "../../../utils/geminiToolOutput.js";

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
}
