import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK } from "../schema/index.js";
import { claudeToOpenAIRequest } from "./claude-to-openai.js";
import { openaiToAntigravityRequest } from "./openai-to-gemini.js";

// Reuse the established image/tool conversion, but carry is_error inside the
// tool payload: the generic OpenAI bridge otherwise drops this Claude flag.
// Google's functionResponse accepts an error object, which context savers must
// leave intact. Do not put nonstandard fields on an OpenAI wire message.
export function claudeToAntigravityRequest(model, original, stream, credentials) {
  const body = structuredClone(original);
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT || block.is_error !== true) continue;
      if (Array.isArray(block.content)) {
        const text = block.content.filter(part => part?.type === CLAUDE_BLOCK.TEXT).map(part => part.text).join("\n");
        block.content = [
          { type: CLAUDE_BLOCK.TEXT, text: JSON.stringify({ error: text }) },
          ...block.content.filter(part => part?.type !== CLAUDE_BLOCK.TEXT),
        ];
      } else block.content = JSON.stringify({ error: block.content ?? "" });
    }
  }
  return openaiToAntigravityRequest(model, claudeToOpenAIRequest(model, body, stream), stream, credentials);
}

register(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, claudeToAntigravityRequest, null);
