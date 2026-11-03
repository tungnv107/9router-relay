import { randomUUID } from 'node:crypto';
import { ANTIGRAVITY_POLICY as schema } from '../../../config/antigravityRelay.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const usageKeys = [...schema.usageFields, ...schema.usageDetailFields];

function responseOf(json) {
  if (!record(json)) return null;
  if (Object.hasOwn(json, 'response')) {
    if (!onlyKeys(json, ['response','traceId']) || json.traceId !== undefined && typeof json.traceId !== 'string') return null;
    json = json.response;
  }
  return onlyKeys(json, schema.responseFields) ? json : null;
}

function usageOf(usage) {
  if (usage === undefined) return {};
  if (!onlyKeys(usage, usageKeys)) return null;
  const result = {};
  for (const key of schema.usageFields) if (usage[key] !== undefined) {
    if (!count(usage[key])) return null;
    result[key] = usage[key];
  }
  for (const key of schema.usageDetailFields) if (usage[key] !== undefined &&
    (!Array.isArray(usage[key]) || usage[key].some(detail => !onlyKeys(detail, ['modality','tokenCount']) ||
      typeof detail.modality !== 'string' || !count(detail.tokenCount)))) return null;
  return result;
}

function inspectResponses(jsons, streaming) {
  const choices = new Map();
  let originalUsage = null;
  for (const json of jsons) {
    const response = responseOf(json);
    if (!response) return null;
    const usage = usageOf(response.usageMetadata);
    if (!usage) return null;
    if (response.usageMetadata) originalUsage = { ...originalUsage, ...usage };
    if (response.candidates === undefined && streaming && response.usageMetadata) continue;
    if (!Array.isArray(response.candidates) || !response.candidates.length) return null;
    const indices = new Set();
    for (let position = 0; position < response.candidates.length; position++) {
      const candidate = response.candidates[position];
      if (!onlyKeys(candidate, schema.candidateFields)) return null;
      const index = candidate.index ?? position;
      if (!count(index) || indices.has(index)) return null;
      indices.add(index);
      if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') return null;
      if (!streaming && candidate.finishReason !== 'STOP') return null;
      if (candidate.safetyRatings !== undefined && (!Array.isArray(candidate.safetyRatings) || candidate.safetyRatings.some(r => r?.blocked))) return null;
      const previous = choices.get(index) || { text: false, finished: false };
      // No further candidate chunks are valid after this candidate finished.
      if (previous.finished) return null;
      let hasText = false;
      if (candidate.content !== undefined) {
        const content = candidate.content;
        if (!onlyKeys(content, ['role','parts']) || content.role !== undefined && content.role !== 'model' || !Array.isArray(content.parts)) return null;
        for (const part of content.parts) {
          // Tool calls, thought text/signatures, images and unknown parts are
          // never replayed, even when a STOP reason was present.
          if (!onlyKeys(part, ['text']) || typeof part.text !== 'string') return null;
          hasText ||= part.text.length > 0;
        }
      }
      choices.set(index, { text: previous.text || hasText, finished: candidate.finishReason === 'STOP' });
    }
  }
  return choices.size && [...choices.values()].every(choice => choice.text && choice.finished) ? { originalUsage } : null;
}

export function inspectAntigravityJson(json) {
  return inspectResponses([json], false);
}

export function inspectAntigravityFrames(frames) {
  const jsons = [];
  let done = false;
  for (const frame of frames) {
    // Native Google uses data-only SSE. Reject unknown named events/errors.
    if (frame.lines.some(line => line.startsWith('event:') && line.slice(6).trim() !== 'message')) return null;
    if (frame.done) { if (done) return null; done = true; continue; }
    if (!frame.json) continue;
    if (done) return null;
    jsons.push(frame.json);
  }
  return inspectResponses(jsons, true);
}

export function rewriteAntigravityReplay(json, ids) {
  const response = json.response || json;
  for (const [object, key] of [[json,'traceId'],[response,'responseId']]) {
    if (typeof object[key] !== 'string') continue;
    if (!ids.has(object[key])) ids.set(object[key], 'local-' + randomUUID());
    object[key] = ids.get(object[key]);
  }
  if (response.createTime !== undefined) response.createTime = new Date().toISOString();
  const original = response.usageMetadata;
  // Always provide explicit zeros, including responses that omitted usage.
  response.usageMetadata = Object.fromEntries(schema.usageFields.map(key => [key, 0]));
  for (const key of schema.usageDetailFields) if (Array.isArray(original?.[key])) {
    response.usageMetadata[key] = original[key].map(detail => ({ ...detail, tokenCount: 0 }));
  }
  for (const candidate of response.candidates || []) if (Object.hasOwn(candidate, 'tokenCount')) candidate.tokenCount = 0;
}
