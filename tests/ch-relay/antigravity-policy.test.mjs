import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../../open-sse/services/chRelay/policy/engine.mjs';
import { defaults, validateConfig } from '../../open-sse/services/chRelay/policy/config.mjs';
import { optimize } from '../../open-sse/services/chRelay/policy/optimizer.mjs';

const route = '/v1/antigravity/v1internal:generateContent';
const streamRoute = '/v1/antigravity/v1internal:streamGenerateContent?alt=sse';
const headers = { authorization: 'Bearer fixture-google', 'content-type': 'application/json', 'x-relay-cache': 'allow', 'x-relay-cache-scope': 'fixture-scope', 'x-relay-principal': 'caller-a' };
const body = { model: 'fixture-model', project: 'project-a', requestId: 'request-1', request: { sessionId: 'session-a', contents: [{ role: 'user', parts: [{ text: 'Static question' }] }] } };
const usage = { promptTokenCount: 120, candidatesTokenCount: 12, totalTokenCount: 132, cachedContentTokenCount: 64, thoughtsTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 120 }] };
const answer = () => ({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'LOCAL_GOOGLE_OK' }] }, finishReason: 'STOP' }], usageMetadata: structuredClone(usage), responseId: 'google-original', modelVersion: 'fixture-model', createTime: '2026-01-01T00:00:00Z' }, traceId: 'trace-original' });
const frame = json => 'data: ' + JSON.stringify(json) + '\n\n';
const sse = () => frame({ response: { responseId: 'google-original', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'LOCAL_' }] } }] } }) + frame({ response: { ...answer().response, candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'GOOGLE_OK' }] }, finishReason: 'STOP' }] } });
function fixture(extra = {}) {
  let config = validateConfig({ ...defaults, mode: 'enforce', ...extra });
  let calls = 0, now = 100000;
  const events = [], received = [];
  let respond = () => Response.json(answer());
  const engine = new PolicyEngine({ readConfig: () => config, now: () => now, audit: event => events.push(event) });
  const delegate = async request => { calls++; received.push({ headers: Object.fromEntries(request.headers), body: await request.json() }); return respond(); };
  const request = (value = body, extraHeaders = {}, path = route) => new Request('http://127.0.0.1:11500' + path, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(value) });
  return { engine, events, received, delegate, request, get calls() { return calls; }, set respond(value) { respond = value; }, set config(value) { config = validateConfig(value); }, advance(ms) { now += ms; },
    async run(value = body, extraHeaders = {}, path = route) { const response = await engine.handle(request(value, extraHeaders, path), delegate); return { response, text: await response.text() }; } };
}

test('Google JSON replay uses no upstream, rewrites IDs and zeros native usage without changing miss usage', async () => {
  const f = fixture();
  const first = await f.run();
  assert.deepEqual(JSON.parse(first.text), answer());
  const hit = await f.run({ ...body, requestId: 'request-2' }, { 'x-relay-local-only': '1' });
  assert.equal(f.calls, 1);
  assert.equal(hit.response.headers.get('x-relay-cache'), 'hit');
  assert.equal(hit.response.headers.get('x-relay-upstream-requests'), '0');
  assert.equal(hit.response.headers.get('x-relay-usage-source'), 'local-cache');
  const result = JSON.parse(hit.text);
  assert.equal(result.response.candidates[0].content.parts[0].text, 'LOCAL_GOOGLE_OK');
  assert.notEqual(result.response.responseId, 'google-original');
  assert.notEqual(result.traceId, 'trace-original');
  assert.equal(result.response.usageMetadata.totalTokenCount, 0);
  assert.equal(result.response.usageMetadata.cachedContentTokenCount, 0);
  assert.equal(result.response.usageMetadata.promptTokensDetails[0].tokenCount, 0);
  assert.equal(f.events.at(-1).original_usage.totalTokenCount, 132);
  assert.ok(!JSON.stringify(f.events).includes('Static question'));
  assert.ok(Object.keys(f.received[0].headers).every(key => !key.startsWith('x-relay-')));
});

test('Google unwrapped responses and missing usage replay with explicit zero counts', async () => {
  const f = fixture();
  f.respond = () => { const json = answer().response; delete json.usageMetadata; return Response.json(json); };
  await f.run(); const hit = await f.run();
  assert.equal(f.calls, 1);
  assert.equal(JSON.parse(hit.text).usageMetadata.totalTokenCount, 0);
});

test('Google SSE caches only at complete EOF and keeps a consistent new response ID', async () => {
  const f = fixture(); f.respond = () => new Response(sse(), { headers: { 'content-type': 'text/event-stream' } });
  const first = await f.engine.handle(f.request(body, {}, streamRoute), f.delegate);
  assert.equal(f.engine.status().cacheEntries, 0);
  await first.text();
  const hit = await f.run(body, { 'x-relay-local-only': '1' }, streamRoute);
  assert.equal(f.calls, 1);
  assert.equal(hit.response.status, 200);
  const jsons = hit.text.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
  assert.equal(jsons[0].response.responseId, jsons[1].response.responseId);
  assert.notEqual(jsons[0].response.responseId, 'google-original');
  assert.ok(jsons.every(json => json.response.usageMetadata.totalTokenCount === 0));
});

for (const [name, extraHeaders, value] of [
  ['credential', { authorization: 'Bearer another-google' }, body],
  ['principal', { 'x-relay-principal': 'caller-b' }, body],
  ['scope', { 'x-relay-cache-scope': 'scope-b' }, body],
  ['billing project', { 'x-goog-user-project': 'billing-b' }, body],
  ['project', {}, { ...body, project: 'project-b' }],
  ['model', {}, { ...body, model: 'model-b' }],
  ['session', {}, { ...body, request: { ...body.request, sessionId: 'session-b' } }],
  ['thinking', {}, { ...body, request: { ...body.request, generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } } }],
  ['prompt', {}, { ...body, request: { ...body.request, contents: [{ role: 'user', parts: [{ text: 'different' }] }] } }],
]) test('Google replay isolates ' + name, async () => {
  const f = fixture(); await f.run();
  const miss = await f.run(value, { ...extraHeaders, 'x-relay-local-only': '1' });
  assert.equal(miss.response.status, 412); assert.equal(f.calls, 1);
});

for (const [name, request, extra] of [
  ['tools', { ...body.request, tools: [{ functionDeclarations: [{ name: 'read' }] }] }, {}],
  ['tool response', { ...body.request, contents: [{ role: 'user', parts: [{ functionResponse: { name: 'read', response: { result: 'text' } } }] }] }, {}],
  ['signed history', { ...body.request, contents: [{ role: 'model', parts: [{ text: 'text', thoughtSignature: 'opaque' }] }] }, {}],
  ['image', { ...body.request, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'bytes' } }] }] }, {}],
  ['explicit remote cache', { ...body.request, cachedContent: 'caches/123' }, {}],
  ['unknown generation', { ...body.request, generationConfig: { unknown: true } }, {}],
  ['no opt-in', body.request, { 'x-relay-cache': '' }],
  ['no scope', body.request, { 'x-relay-cache-scope': '' }],
  ['cookie', body.request, { cookie: 'session' }],
  ['no-store', body.request, { 'cache-control': 'no-store' }],
]) test('Google bypasses replay for ' + name, async () => {
  const f = fixture(), value = { ...body, request }; await f.run(value, extra); await f.run(value, extra);
  assert.equal(f.calls, 2); assert.equal(f.engine.status().cacheEntries, 0);
});

for (const [name, mutate] of [
  ['signed text', json => { json.response.candidates[0].content.parts[0].thoughtSignature = 'opaque'; }],
  ['thoughts', json => { json.response.candidates[0].content.parts[0].thought = true; }],
  ['tool call', json => { json.response.candidates[0].content.parts = [{ functionCall: { name: 'read', args: {} } }]; }],
  ['truncated output', json => { json.response.candidates[0].finishReason = 'MAX_TOKENS'; }],
  ['missing completion', json => { delete json.response.candidates[0].finishReason; }],
  ['blocked', json => { json.response.promptFeedback = { blockReason: 'SAFETY' }; }],
  ['error', json => { json.error = { message: 'failed' }; }],
  ['untrusted usage', json => { json.response.usageMetadata.promptTokenCount = 'PRIVATE'; }],
]) test('Google rejects cache response with ' + name, async () => {
  const f = fixture(); f.respond = () => { const json = answer(); mutate(json); return Response.json(json); };
  await f.run(); await f.run(); assert.equal(f.calls, 2); assert.equal(f.engine.status().cacheEntries, 0);
});

for (const [name, text] of [
  ['incomplete frame', sse().trimEnd()],
  ['error after stop', sse() + frame({ error: { message: 'failed' } })],
  ['unknown event', 'event: error\n' + sse()],
  ['text after stop', sse() + frame(answer())],
  ['no STOP', frame({ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } })],
]) test('Google SSE does not cache ' + name, async () => {
  const f = fixture(); f.respond = () => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  await f.run(body, {}, streamRoute); await f.run(body, {}, streamRoute); assert.equal(f.calls, 2);
});

test('Google cache honors upstream no-store and set-cookie', async () => {
  for (const extra of [{ 'cache-control': 'no-store' }, { 'set-cookie': 'session=x' }]) {
    const f = fixture(); f.respond = () => Response.json(answer(), { headers: extra });
    await f.run(); await f.run(); assert.equal(f.calls, 2);
  }
});

test('Google cache observes TTL, kill switch, dry-run and off', async () => {
  const f = fixture(); await f.run(); f.advance(defaults.cache.ttlMs + 1); await f.run(); assert.equal(f.calls, 2);
  f.config = { ...defaults, mode: 'enforce', killSwitch: 'block' };
  assert.equal((await f.run()).response.status, 503); assert.equal(f.calls, 2);
  for (const mode of ['dry-run','off']) {
    const g = fixture({ mode }); await g.run(); await g.run(); assert.equal(g.calls, 2);
    assert.equal((await g.run(body, { 'x-relay-local-only': '1' })).response.status, 412);
  }
});

test('Google cancelled and broken streams never seed a replay', async () => {
  for (const broken of [false,true]) {
    const f = fixture(); f.respond = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame(answer()))); if (broken) controller.error(Error('reset')); } }), { headers: { 'content-type': 'text/event-stream' } });
    const response = await f.engine.handle(f.request(body, {}, streamRoute), f.delegate);
    if (broken) await assert.rejects(response.text()); else await response.body.cancel();
    assert.equal(f.engine.status().cacheEntries, 0); assert.equal(f.engine.status().activeDelegates, 0);
  }
});

test('Google numeric thinking defaults/caps require a model rule and two explicit downgrade opt-ins', () => {
  const config = validateConfig({ ...defaults, reasoning: { antigravityModels: { 'fixture-model': { field: 'thinkingBudget', defaultValue: 1024, maxValue: 2048, allowExplicitDowngrade: true } } } });
  const run = (value, allow = false, c = config) => optimize(value, new Headers(allow ? { 'x-relay-reasoning': 'allow-downgrade' } : {}), c, Buffer.alloc(32), route).body;
  assert.equal(run(body).request.generationConfig.thinkingConfig.thinkingBudget, 1024);
  for (const budget of [8192,-1]) {
    const value = { ...body, request: { ...body.request, generationConfig: { maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } } };
    assert.deepEqual(run(value), value);
    assert.deepEqual(run(value, true).request.generationConfig, { maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } });
  }
  assert.deepEqual(run({ ...body, model: 'unconfigured-model' }), { ...body, model: 'unconfigured-model' });
  const alternate = { ...body, request: { ...body.request, generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } };
  assert.deepEqual(run(alternate, true), alternate);
  assert.equal(run(body).prompt_cache_key, undefined);
  assert.equal(run(body).reasoning, undefined);
});

test('Google native thinking levels preserve caller values without downgrade permission', () => {
  const config = validateConfig({ ...defaults, reasoning: { antigravityModels: { 'fixture-model': { field: 'thinkingLevel', supported: ['minimal','low','medium','high'], defaultValue: 'low', maxValue: 'medium', allowExplicitDowngrade: true } } } });
  const value = { ...body, request: { ...body.request, generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } } } };
  const run = h => optimize(value, new Headers(h), config, Buffer.alloc(32), route).body;
  assert.deepEqual(run({}), value);
  assert.equal(run({ 'x-relay-reasoning': 'allow-downgrade' }).request.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  config.reasoning.antigravityModels['fixture-model'].allowExplicitDowngrade = false;
  assert.deepEqual(run({ 'x-relay-reasoning': 'allow-downgrade' }), value);
});

test('Google thinking configuration rejects unsupported fields, levels and inconsistent limits', () => {
  for (const rule of [
    { field: 'reasoning_effort' }, { field: 'thinkingBudget', defaultValue: -2 },
    { field: 'thinkingBudget', maxValue: -1 }, { field: 'thinkingBudget', defaultValue: 4096, maxValue: 1024 },
    { field: 'thinkingLevel', supported: ['high','low'] }, { field: 'thinkingLevel', supported: ['low'], defaultValue: 'max' },
  ]) assert.throws(() => validateConfig({ ...defaults, reasoning: { antigravityModels: { 'fixture-model': rule } } }));
});
