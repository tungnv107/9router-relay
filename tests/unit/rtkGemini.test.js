import { describe, expect, it } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";

const output = Array.from({ length: 80 }, (_, i) => `src/file.js:${i + 1}:matching source line with enough content to compress`).join("\n");
const response = value => ({ functionResponse: { id: "call_1", name: "read", response: value } });

describe("RTK native Google tool results", () => {
  it.each([false, true])("compresses tool text with envelope=%s without changing native state", wrapped => {
    const request = {
      systemInstruction: { parts: [{ text: output }] },
      contents: [
        { role: "user", parts: [{ text: output }] },
        { role: "model", parts: [{ functionCall: { id: "call_1", name: "read", args: { text: output } }, thoughtSignature: "signed" }] },
        { role: "user", parts: [response({ result: { result: output } }), { inlineData: { mimeType: "image/png", data: output } }] },
      ],
      generationConfig: { thinkingConfig: { thinkingBudget: 8192 }, maxOutputTokens: 16384 },
      sessionId: "stable-session",
    };
    const body = wrapped ? { model: "fixture", project: "project", request } : request;
    const original = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(stats.hits).toHaveLength(1);
    const text = request.contents[2].parts[0].functionResponse.response.result.result;
    expect(text).toContain("src/file.js");
    expect(text.length).toBeLessThan(output.length);
    request.contents[2].parts[0].functionResponse.response.result.result = output;
    expect(body).toEqual(original);
  });

  it("preserves errors, structured JSON, image blocks, metadata and disabled requests", () => {
    const body = { request: { contents: [{ parts: [
      response({ result: output, error: { message: "failure" } }),
      response({ result: { output, exit_code: 1 } }),
      response({ result: { output, is_error: true } }),
      response({ result: { output, status: "error" } }),
      response({ result: JSON.stringify({ output }) }),
      response({ result: [{ type: "image", text: output }] }),
      response({ arbitraryField: output }),
    ] }] } };
    const original = structuredClone(body);
    expect(compressMessages(body, true).hits).toHaveLength(0);
    expect(body).toEqual(original);
    const disabled = { contents: [{ parts: [response({ result: output })] }] };
    expect(compressMessages(disabled, false)).toBeNull();
    expect(disabled.contents[0].parts[0].functionResponse.response.result).toBe(output);
  });

  it("handles text arrays while preserving images and tool-call identity", () => {
    const body = { contents: [{ parts: [response({ content: [
      { type: "text", text: output }, { type: "input_text", text: output },
      { type: "image", data: output },
    ] })] }] };
    const stats = compressMessages(body, true);
    expect(stats.hits).toHaveLength(2);
    const tool = body.contents[0].parts[0].functionResponse;
    expect(tool.id).toBe("call_1");
    expect(tool.response.content[2].data).toBe(output);
  });

  it("leaves excessively deep or cyclic payloads intact", () => {
    let value = output;
    for (let i = 0; i < 20; i++) value = { result: value };
    const cycle = {}; cycle.result = cycle;
    const body = { contents: [{ parts: [response(value), response(cycle)] }] };
    expect(compressMessages(body, true).hits).toHaveLength(0);
    expect(body.contents[0].parts[0].functionResponse.response).toBe(value);
  });
});
