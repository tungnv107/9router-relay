import { GEMINI_TOOL_OUTPUT } from "../config/geminiToolOutput.js";
import { OPENAI_BLOCK, RESPONSES_ITEM } from "../translator/schema/index.js";

const isError = value => value && typeof value === "object" && (
  value.is_error === true || value.isError === true || Object.hasOwn(value, "error") ||
  GEMINI_TOOL_OUTPUT.errorStatuses.includes(value.status) ||
  [value.exit_code, value.exitCode].some(code => typeof code === "number" && code !== 0)
);

// Return only plain-text tool outputs, never arbitrary JSON properties, call
// arguments, images, signatures or user/system text. Callers apply edits after
// collecting/computing every replacement so a failed traversal changes nothing.
export function collectGeminiToolOutputText(body) {
  const contents = body?.request?.contents ?? body?.contents;
  if (!Array.isArray(contents)) return null;
  const targets = [], seen = new WeakSet();
  const visit = (object, key, depth = 0) => {
    if (depth > GEMINI_TOOL_OUTPUT.maxDepth || isError(object)) return;
    const value = object?.[key];
    if (typeof value === "string") {
      if (!value.trim()) return;
      try { JSON.parse(value); return; } catch { /* plain text */ }
      targets.push({ object, key, text: value });
    } else if (value && typeof value === "object") {
      if (seen.has(value) || isError(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) visit(value, i, depth + 1);
      } else {
        if (value.type && ![OPENAI_BLOCK.TEXT, RESPONSES_ITEM.INPUT_TEXT].includes(value.type)) return;
        for (const field of GEMINI_TOOL_OUTPUT.textFields) {
          if (Object.hasOwn(value, field)) visit(value, field, depth + 1);
        }
      }
    }
  };
  for (const content of contents) {
    if (!Array.isArray(content?.parts)) continue;
    for (const part of content.parts) {
      if (part?.functionResponse && !isError(part)) visit(part.functionResponse, "response");
    }
  }
  return targets;
}
