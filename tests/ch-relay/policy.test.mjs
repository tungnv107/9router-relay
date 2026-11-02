import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../../open-sse/services/chRelay/policy/engine.mjs';
import { defaults, FileControl, validateConfig } from '../../open-sse/services/chRelay/policy/config.mjs';
import { optimize } from '../../open-sse/services/chRelay/policy/optimizer.mjs';

const usage={input_tokens:120,output_tokens:12,total_tokens:132,input_tokens_details:{cached_tokens:64},output_tokens_details:{reasoning_tokens:0}};
const answer=()=>({id:'resp_original',object:'response',status:'completed',model:'test-model',output:[{id:'msg_original',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'LOCAL_OK',annotations:[]}]}],usage});
const body={model:'test-model',input:'Static input only',stream:false,store:false};
const baseHeaders={authorization:'Bearer synthetic-token','content-type':'application/json','x-relay-cache':'allow','x-relay-cache-scope':'fixture-v1'};
const req=(value=body,headers={},endpoint='/v1/responses')=>new Request('http://127.0.0.1:11610'+endpoint,{method:'POST',headers:{...baseHeaders,...headers},body:typeof value==='string'?value:JSON.stringify(value)});
function fixture(mode='enforce',extra={}) {
  let config=validateConfig({...defaults,mode,...extra}),time=100000, calls=0;const events=[],received=[];
  const engine=new PolicyEngine({readConfig:()=>config,now:()=>time,audit:x=>events.push(x),secret:Buffer.alloc(32,7)});
  let respond=()=>Response.json(answer());
  const delegate=async request=>{calls++;received.push({body:await request.text(),headers:Object.fromEntries(request.headers)});return respond();};
  return {engine,events,received,delegate,get calls(){return calls;},set config(v){config=v;},get config(){return config;},set respond(v){respond=v;},advance(ms){time+=ms;},async run(value=body,headers={},endpoint){const r=await engine.handle(req(value,headers,endpoint),delegate);return {status:r.status,headers:r.headers,text:await r.text()};}};
}
const sse=(a=answer())=>['response.created','response.in_progress','response.output_item.added','response.output_text.delta','response.output_item.done','response.completed'].map((type,i)=>'event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:i,...type==='response.completed'?{response:a}:type.includes('item')?{output_index:0,item:a.output[0]}:type==='response.output_text.delta'?{delta:'LOCAL_OK',item_id:'msg_original',output_index:0,content_index:0}:{response:{id:a.id,object:'response',status:'in_progress',output:[]}}})+'\n\n').join('');

test('completed JSON cache hit has zero delegate calls and zero replay usage',async()=>{
  const f=fixture();const first=await f.run();assert.equal(f.calls,1);assert.deepEqual(JSON.parse(first.text).usage,usage);
  const hit=await f.run();assert.equal(f.calls,1);assert.equal(hit.headers.get('x-relay-upstream-requests'),'0');assert.equal(hit.headers.get('x-relay-cache'),'hit');assert.equal(JSON.parse(hit.text).usage.total_tokens,0);assert.notEqual(JSON.parse(hit.text).id,'resp_original');assert.equal(f.events.at(-1).original_usage.total_tokens,132);
});
test('dry-run never transforms or short-circuits even with a shadow cache hit',async()=>{
  const f=fixture('dry-run',{context:{deduplicateTools:true,maxToolOutputChars:0},promptCache:{enabled:true,models:['test-model']}});
  const raw=JSON.stringify(body,null,4);await f.run(raw);await f.run(raw);assert.equal(f.calls,2);assert.equal(f.engine.counters.shadow_hits,1);assert.equal(f.received[1].body,raw);assert.equal(f.events.at(-1).applied,false);assert.ok(f.events.at(-1).proposed_changes.includes('prompt_cache_key_added'));
});
test('off bypasses cache and all optimizers',async()=>{
  const f=fixture('off',{promptCache:{enabled:true,models:['test-model']}});await f.run();await f.run();assert.equal(f.calls,2);assert.equal(f.engine.status().cacheEntries,0);assert.equal(f.received[0].body,JSON.stringify(body));
});
test('local-only miss and dry-run hit never call delegate',async()=>{
  for(const mode of ['off','dry-run','enforce']) {const f=fixture(mode);const r=await f.run(body,{'x-relay-local-only':'1'});assert.equal(r.status,412);assert.equal(f.calls,0);}
  const f=fixture('dry-run');await f.run();await f.run(body,{'x-relay-local-only':'1'});assert.equal(f.calls,1);
});
test('local-only hit serves a previously warmed immutable result',async()=>{const f=fixture();await f.run();const r=await f.run(body,{'x-relay-local-only':'1'});assert.equal(r.status,200);assert.equal(f.calls,1);});
for(const [name,headers] of Object.entries({credential:{authorization:'Bearer other-token'},account:{'chatgpt-account-id':'other'},scope:{'x-relay-cache-scope':'other'},accept:{accept:'text/event-stream'},organization:{'openai-organization':'other'},project:{'openai-project':'other'}})) {
  test('cache isolates '+name,async()=>{const f=fixture();await f.run();await f.run(body,headers);assert.equal(f.calls,2);});
}
for(const [name,value] of Object.entries({model:{...body,model:'other'},prompt:{...body,input:'Other'},effort:{...body,reasoning:{effort:'high'}},format:{...body,text:{format:{type:'json_object'}}}})) {
  test('cache isolates '+name,async()=>{const f=fixture();await f.run();await f.run(value);assert.equal(f.calls,2);});
}
for(const [name,value,headers] of [
  ['tool declarations',{...body,tools:[{type:'function',name:'exec',parameters:{type:'object'}}]},{}],
  ['tool history',{...body,input:[{type:'function_call_output',call_id:'call_1',output:'secret'}]},{}],
  ['reasoning state',{...body,input:[{type:'reasoning',encrypted_content:'opaque'}]},{}],
  ['previous response',{...body,previous_response_id:'resp_1'},{}],
  ['images',{...body,input:[{role:'user',content:[{type:'input_image',image_url:'https://example.invalid/image'}]}]},{}],
  ['stored response',{...body,store:true},{}],['unknown request field',{...body,unexpected:true},{}],
  ['no opt-in',body,{'x-relay-cache':''}],['no scope',body,{'x-relay-cache-scope':''}],['missing auth',body,{authorization:''}],
  ['client no-store',body,{'cache-control':'no-store'}],['explicit bypass',body,{'x-relay-cache':'bypass'}],['cookie',body,{cookie:'session=1'}]
]) test('does not cache '+name,async()=>{const f=fixture();await f.run(value,headers);await f.run(value,headers);assert.equal(f.calls,2);assert.equal(f.engine.status().cacheEntries,0);});
test('JWT expiry prevents replay and caps entry lifetime',async()=>{
  const f=fixture();const token='e30.'+Buffer.from(JSON.stringify({exp:101})).toString('base64url')+'.synthetic';const headers={authorization:'Bearer '+token};await f.run(body,headers);f.advance(1100);await f.run(body,headers);assert.equal(f.calls,2);
});
test('cache TTL expiry triggers a fresh delegate call',async()=>{const f=fixture();await f.run();f.advance(300001);await f.run();assert.equal(f.calls,2);});
test('LRU obeys entry and byte limits',async()=>{
  const f=fixture('enforce',{cache:{...defaults.cache,maxEntries:1,maxBytes:4096,maxEntryBytes:2048}});await f.run();await f.run({...body,input:'second'});assert.equal(f.engine.status().cacheEntries,1);assert.ok(f.engine.status().cacheBytes<=4096);await f.run();assert.equal(f.calls,3);assert.equal(f.engine.counters.evictions,2);
});
for(const [name,response] of [
  ['429',()=>new Response('rate limited',{status:429})],['500',()=>new Response('error',{status:500})],
  ['incomplete',()=>Response.json({...answer(),status:'incomplete'})],['error payload',()=>Response.json({...answer(),error:{message:'bad'}})],
  ['tool call',()=>Response.json({...answer(),output:[{type:'function_call',name:'exec',arguments:'{}',call_id:'call_1'}]})],
  ['encrypted reasoning',()=>Response.json({...answer(),output:[{type:'reasoning',encrypted_content:'opaque'},...answer().output]})],
  ['malformed JSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],
  ['no-store',()=>Response.json(answer(),{headers:{'cache-control':'no-store'}})],['set-cookie',()=>Response.json(answer(),{headers:{'set-cookie':'x=y'}})],
  ['unknown media type',()=>new Response('ok')]
]) test('never caches '+name,async()=>{const f=fixture();f.respond=response;await f.run();await f.run();assert.equal(f.calls,2);assert.equal(f.engine.status().cacheEntries,0);});
test('valid Responses SSE caches only after EOF and replays consistently',async()=>{
  const f=fixture();f.respond=()=>new Response(sse(),{headers:{'content-type':'text/event-stream'}});const pending=await f.engine.handle(req({...body,stream:true}),f.delegate);assert.equal(f.engine.status().cacheEntries,0);await pending.text();const r=await f.run({...body,stream:true});assert.equal(f.calls,1);assert.match(r.text,/response.completed/);assert.doesNotMatch(r.text,/resp_original|msg_original/);assert.match(r.text,/"total_tokens":0/);
});
for(const [name,text] of [['truncated',sse().slice(0,-10)],['error event',sse()+'data: {"type":"error","error":"bad"}\n\n'],['missing completion',sse().slice(0,sse().lastIndexOf('event: response.completed'))],['unknown event',sse()+'data: {"type":"response.function_call_arguments.delta"}\n\n']]) {
  test('rejects SSE '+name,async()=>{const f=fixture();f.respond=()=>new Response(text,{headers:{'content-type':'text/event-stream'}});await f.run({...body,stream:true});await f.run({...body,stream:true});assert.equal(f.calls,2);});
}
test('Chat Completions JSON and SSE cache safely',async()=>{
  const request={model:'test-model',messages:[{role:'user',content:'Static'}],stream:false};
  const f=fixture();f.respond=()=>Response.json({id:'chatcmpl-origin',object:'chat.completion',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}});
  await f.run(request,{},'/v1/chat/completions');const hit=await f.run(request,{},'/v1/chat/completions');assert.equal(f.calls,1);assert.equal(JSON.parse(hit.text).usage.total_tokens,0);
  const g=fixture();g.respond=()=>new Response('data: '+JSON.stringify({id:'chatcmpl-origin',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'chatcmpl-origin',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  await g.run({...request,stream:true},{},'/v1/chat/completions');await g.run({...request,stream:true},{},'/v1/chat/completions');assert.equal(g.calls,1);
});
test('stream cancellation and stream failure never seed cache',async()=>{
  for(const fail of [false,true]){const f=fixture();f.respond=()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('event: response.created\ndata: {}\n\n'));if(fail)c.error(Error('network reset'));}}),{headers:{'content-type':'text/event-stream'}});const r=await f.engine.handle(req(),f.delegate);if(fail)await assert.rejects(r.text());else await r.body.cancel();assert.equal(f.engine.status().cacheEntries,0);assert.equal(f.engine.status().activeDelegates,0);}
});
test('kill bypass invalidates cache and block stops all guarded routes',async()=>{
  const f=fixture();await f.run();f.config={...f.config,killSwitch:'bypass'};await f.run();assert.equal(f.calls,2);assert.equal(f.engine.status().cacheEntries,0);
  f.config={...f.config,killSwitch:'block'};for(const endpoint of ['/v1/responses','/v1/responses/compact','/v1/images/generations']){const r=await f.run(body,{},endpoint);assert.equal(r.status,503);}assert.equal(f.calls,2);
});
test('config changes invalidate in-flight cache writes',async()=>{
  const f=fixture();const r=await f.engine.handle(req(),f.delegate);f.config={...f.config,mode:'off'};await r.text();assert.equal(f.engine.status().cacheEntries,0);
});
test('block aborts an active delegate',async()=>{
  const f=fixture();let entered;const ready=new Promise(r=>entered=r);const pending=f.engine.handle(req(),request=>new Promise((_,reject)=>{entered();request.signal.addEventListener('abort',()=>reject(request.signal.reason));}));await ready;f.config={...f.config,killSwitch:'block'};f.engine.refresh();await assert.rejects(pending,/kill switch/);assert.equal(f.engine.status().activeDelegates,0);
});
test('local-only body limit and malformed JSON block without delegate',async()=>{const f=fixture('enforce',{cache:{...defaults.cache,maxRequestBytes:512}});assert.equal((await f.run('x'.repeat(513),{'x-relay-local-only':'1'})).status,413);assert.equal((await f.run('{',{'x-relay-local-only':'1'})).status,400);assert.equal(f.calls,0);});
test('oversized and malformed requests pass through byte-for-byte outside local-only',async()=>{const f=fixture('dry-run',{cache:{...defaults.cache,maxRequestBytes:512}});const large=JSON.stringify({...body,input:'z'.repeat(2048)});await f.run(large);await f.run('{');assert.equal(f.received[0].body,large);assert.equal(f.received[1].body,'{');assert.equal(f.engine.status().cacheEntries,0);});
test('oversized response is delivered but not cached',async()=>{const f=fixture('enforce',{cache:{...defaults.cache,maxEntryBytes:512}});const a=answer();a.output[0].content[0].text='z'.repeat(2048);f.respond=()=>Response.json(a);assert.match((await f.run()).text,/zzzz/);assert.equal(f.engine.status().cacheEntries,0);});
test('relay controls never reach the delegate and upstream cannot forge local-hit proof',async()=>{const f=fixture();f.respond=()=>Response.json(answer(),{headers:{'x-relay-upstream-requests':'0','x-relay-cache':'hit'}});const r=await f.run();assert.equal(r.headers.get('x-relay-upstream-requests'),null);assert.equal(r.headers.get('x-relay-cache'),'miss');assert.ok(Object.keys(f.received[0].headers).every(k=>!k.startsWith('x-relay-')));});
test('audit contains neither prompt, credential nor scope',async()=>{const f=fixture();await f.run();await f.run();const log=JSON.stringify(f.events);for(const secret of ['Static input only','synthetic-token','fixture-v1','LOCAL_OK'])assert.ok(!log.includes(secret));});
test('audit failure does not retry or fail inference',async()=>{const f=fixture();f.engine.audit=()=>{throw Error('disk full');};assert.equal((await f.run()).status,200);assert.equal(f.calls,1);assert.equal(f.engine.counters.audit_errors,1);});
test('untrusted usage fields cannot leak strings into the audit log',async()=>{const f=fixture();f.respond=()=>Response.json({...answer(),usage:{...usage,prompt:'PRIVATE_STRING',input_tokens_details:{cached_tokens:2,prompt:'PRIVATE_STRING'}}});await f.run();await f.run();assert.ok(!JSON.stringify(f.events).includes('PRIVATE_STRING'));});
test('prompt cache keys preserve explicit keys and distinguish scopes and principals',()=>{
  const c=validateConfig({...defaults,promptCache:{enabled:true,models:['test-model']}}),secret=Buffer.alloc(32,1),h=new Headers(baseHeaders);
  const a=optimize(body,h,c,secret,'/v1/responses').body.prompt_cache_key;assert.equal(a,optimize({...body,input:'Next turn'},h,c,secret,'/v1/responses').body.prompt_cache_key);h.set('x-relay-cache-scope','another');assert.notEqual(a,optimize(body,h,c,secret,'/v1/responses').body.prompt_cache_key);assert.equal(optimize({...body,prompt_cache_key:'explicit'},h,c,secret,'/v1/responses').body.prompt_cache_key,'explicit');assert.equal(optimize({...body,model:'unsupported'},h,c,secret,'/v1/responses').body.prompt_cache_key,undefined);
});
test('context optimizer preserves ordering, encrypted state and caller-owned strings',()=>{
  const c=validateConfig({...defaults,context:{deduplicateTools:true,maxToolOutputChars:256}}),h=new Headers({...baseHeaders,'x-relay-context':'truncate-tool-output'}),tool={type:'function',name:'read',parameters:{type:'object'}};
  const b={...body,tools:[tool,tool,{...tool,description:'distinct'}],input:[{type:'reasoning',encrypted_content:'opaque'},{type:'function_call',call_id:'c',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'z'.repeat(1000)},{role:'user',content:'z'.repeat(1000)}]};
  const o=optimize(b,h,c,Buffer.alloc(32),'/v1/responses');assert.equal(o.body.tools.length,2);assert.deepEqual(o.body.input[0],b.input[0]);assert.deepEqual(o.body.input[1],b.input[1]);assert.equal(o.body.input[2].call_id,'c');assert.ok(o.body.input[2].output.length<=256);assert.equal(o.body.input[3].content,b.input[3].content);assert.equal(b.input[2].output.length,1000);
});
test('reasoning optimizer preserves explicit effort unless two opt-ins are present',()=>{
  const c=validateConfig({...defaults,reasoning:{models:{'test-model':{supported:['low','medium','high'],defaultEffort:'low',maxEffort:'medium',allowExplicitDowngrade:true}}}}),h=new Headers(baseHeaders),secret=Buffer.alloc(32);
  assert.equal(optimize(body,h,c,secret,'/v1/responses').body.reasoning.effort,'low');const b={...body,reasoning:{effort:'high',summary:'auto',context:'all_turns'}};assert.deepEqual(optimize(b,h,c,secret,'/v1/responses').body.reasoning,b.reasoning);h.set('x-relay-reasoning','allow-downgrade');assert.deepEqual(optimize(b,h,c,secret,'/v1/responses').body.reasoning,{...b.reasoning,effort:'medium'});
});
test('config validation, atomic update, rollback and emergency sentinel',()=>{
  const dir=fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'control-test-')),filename=path.join(dir,'policy.json'),control=new FileControl(filename,{});
  try {control.write(defaults);control.write({...defaults,mode:'enforce'});assert.equal(control.read().mode,'enforce');control.rollback();assert.equal(control.read().mode,'dry-run');assert.throws(()=>control.write({...defaults,mode:'bad'}));fs.writeFileSync(filename,'{');assert.equal(control.read().killSwitch,'block');fs.writeFileSync(filename,JSON.stringify(defaults));fs.writeFileSync(path.join(dir,'KILL_SWITCH'),'block');assert.equal(control.read().killSwitch,'block');assert.throws(()=>validateConfig({...defaults,silentOption:true}));}finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
