import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { defaults, validateConfig, revisionOf } from './config.mjs';
import { optimize } from './optimizer.mjs';
import { inspectReplay, replayBytes } from './replay.mjs';

const endpoints=new Set(['/v1/responses','/v1/chat/completions']);
const hop=new Set(['connection','keep-alive','transfer-encoding','content-length','host','proxy-authorization','proxy-authenticate','upgrade','trailer','te']);
const scopePattern=/^[A-Za-z0-9_.:/-]{1,160}$/;
function safeResponseHeaders(original) {
  const h=new Headers(original);
  for (const key of [...h.keys()]) if (key.startsWith('x-relay-') || hop.has(key)) h.delete(key);
  return h;
}
function outgoing(request, bytes, signal) {
  const headers=new Headers(request.headers);
  for (const key of [...headers.keys()]) if (key.startsWith('x-relay-') || hop.has(key)) headers.delete(key);
  return new Request(request.url,{method:request.method,headers,body:bytes,signal,duplex:'half'});
}
function authDeadline(headers, now) {
  const auth=headers.get('authorization');
  if (!auth || !/^Bearer \S+$/i.test(auth)) return 0;
  const parts=auth.slice(7).split('.');
  if (parts.length!==3) return Infinity; // Opaque credentials still isolated by the entire credential, never a claimed identity.
  try {
    const p=JSON.parse(Buffer.from(parts[1],'base64url').toString());
    if (!Number.isFinite(p.exp) || p.exp*1000<=now || (p.nbf!==undefined && (!Number.isFinite(p.nbf) || p.nbf*1000>now))) return 0;
    return p.exp*1000;
  } catch { return 0; }
}
function eligibility(body, headers, endpoint, config, now) {
  if (!config.cache.enabled) return 'cache_disabled';
  if (headers.get('x-relay-cache')==='bypass' || /no-store|no-cache/i.test(headers.get('cache-control')??'')) return 'client_bypass';
  if (config.cache.requireOptIn && headers.get('x-relay-cache')!=='allow') return 'opt_in_required';
  if (!scopePattern.test(headers.get('x-relay-cache-scope')??'')) return 'scope_required';
  if (!authDeadline(headers,now)) return 'credential_missing_or_expired';
  if (!body || typeof body!=='object' || Array.isArray(body) || typeof body.model!=='string' || !body.model) return 'invalid_body';
  if (headers.has('cookie') || headers.has('idempotency-key')) return 'stateful_header';
  if (body.store===true || body.background || body.previous_response_id || body.conversation || body.tools?.length || body.include?.length || body.audio || body.modalities || body.prediction) return 'tools_or_state';
  const common=['model','stream','store','temperature','top_p','seed','metadata','user','service_tier','prompt_cache_key','prompt_cache_retention','prompt_cache_options'];
  const allowed=new Set([...common,...(endpoint==='/v1/responses' ? ['input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','max_output_tokens','truncation','include'] : ['messages','tools','tool_choice','parallel_tool_calls','reasoning_effort','response_format','max_tokens','max_completion_tokens','stream_options','n','presence_penalty','frequency_penalty','logit_bias','logprobs','top_logprobs'])]);
  if (Object.keys(body).some(k=>!allowed.has(k))) return 'unknown_request_field';
  if (body.tools && (!Array.isArray(body.tools) || body.tools.length)) return 'tools_or_state';
  const plainMessage=message=>message && ['user','assistant','system','developer'].includes(message.role) && Object.keys(message).every(k=>['role','content','type'].includes(k)) && (!message.type || message.type==='message') &&
    (typeof message.content==='string' || Array.isArray(message.content) && message.content.every(p=>p && ['text','input_text','output_text'].includes(p.type) && typeof p.text==='string' && Object.keys(p).every(k=>['type','text'].includes(k))));
  const content=endpoint==='/v1/responses' ? body.input : body.messages;
  if (!(endpoint==='/v1/responses' && typeof content==='string') && !(Array.isArray(content) && content.length && content.every(plainMessage))) return 'non_text_or_tool_history';
  return null;
}
function localError(message,status=412) { return Response.json({error:{message,type:'local_policy_error',code:'LOCAL_POLICY_NO_UPSTREAM'}},{status,headers:{'x-relay-upstream-requests':'0','x-relay-billable-tokens':'0','cache-control':'no-store'}}); }
export class PolicyEngine {
  constructor({readConfig=()=>defaults,now=Date.now,audit=()=>{},secret=randomBytes(32)}={}) {
    this.readConfig=readConfig; this.now=now; this.audit=audit; this.secret=secret;
    this.cache=new Map(); this.bytes=0; this.epoch=0; this.active=new Set();
    this.counters={requests:0,local_hits:0,local_blocks:0,delegate_calls:0,shadow_hits:0,cache_stores:0,rejected_responses:0,evictions:0,audit_errors:0,delegate_errors:0};
    this.refresh();
  }
  refresh() {
    let config;
    try { config=validateConfig(this.readConfig()); } catch { config={...structuredClone(defaults),killSwitch:'block'}; }
    const revision=revisionOf(config);
    if (revision!==this.revision) { this.cache.clear(); this.bytes=0; this.epoch++; this.config=config; this.revision=revision; }
    if (config.killSwitch==='block') for (const controller of this.active) controller.abort(new Error('Local policy kill switch'));
    return config;
  }
  clear() { this.cache.clear(); this.bytes=0; this.epoch++; }
  status() { this.refresh(); this.prune(); return {revision:this.revision,mode:this.config.mode,killSwitch:this.config.killSwitch,cacheEntries:this.cache.size,cacheBytes:this.bytes,activeDelegates:this.active.size,counters:{...this.counters},legacyCacheDisabled:true}; }
  event(value) { try { this.audit({at:new Date(this.now()).toISOString(),revision:this.revision,...value}); } catch { this.counters.audit_errors++; } }
  prune() { for (const [key,entry] of this.cache) if (entry.expires<=this.now()) this.remove(key); }
  remove(key) { const e=this.cache.get(key); if(e) { this.bytes-=e.size; this.cache.delete(key); } }
  get(key) { const e=this.cache.get(key); if (!e) return null; if(e.expires<=this.now()){this.remove(key);return null;} this.cache.delete(key);this.cache.set(key,e);return e; }
  put(key,entry,epoch) {
    this.refresh(); if (epoch!==this.epoch) return;
    this.prune(); if(entry.expires<=this.now() || entry.size>this.config.cache.maxEntryBytes || entry.size>this.config.cache.maxBytes) return;
    this.remove(key);
    while(this.cache.size>=this.config.cache.maxEntries || this.bytes+entry.size>this.config.cache.maxBytes) { this.remove(this.cache.keys().next().value); this.counters.evictions++; }
    this.cache.set(key,entry);this.bytes+=entry.size;this.counters.cache_stores++;
  }
  async handle(request, delegate) {
    const config=this.refresh(), epoch=this.epoch, endpoint=new URL(request.url).pathname;
    this.counters.requests++;
    const requestId=randomUUID(), only=request.headers.get('x-relay-local-only')==='1';
    const event=(decision,extra={})=>this.event({requestId,endpoint,mode:config.mode,decision,...extra});
    const deny=(message,status=412)=>{this.counters.local_blocks++;event('blocked',{upstream_requests:0});return localError(message,status);};
    if (config.killSwitch==='block') return deny('Local policy kill switch is blocking requests',503);
    const passthrough=async req=> {
      const controller=new AbortController();this.active.add(controller);
      const signal=AbortSignal.any([request.signal,controller.signal]);
      this.refresh();
      if(signal.aborted) {this.active.delete(controller);return deny('Request cancelled before forwarding',499);}
      this.counters.delegate_calls++;
      let response;
      try { response=await delegate(new Request(req,{signal,duplex:'half'})); }
      catch(error) {this.active.delete(controller);this.counters.delegate_errors++;event('delegate_error');throw error;}
      const headers=safeResponseHeaders(response.headers);
      headers.set('x-relay-policy-mode',config.killSwitch==='bypass'?'off':config.mode);headers.set('x-relay-policy-revision',this.revision);
      headers.set('x-relay-cache','bypass');
      if (!response.body) {this.active.delete(controller);return new Response(null,{status:response.status,headers});}
      const reader=response.body.getReader(), active=this.active;
      const stream=new ReadableStream({async pull(c){try {const v=await reader.read();if(v.done){active.delete(controller);c.close();}else c.enqueue(v.value);}catch(e){active.delete(controller);c.error(e);}},async cancel(reason){active.delete(controller);controller.abort(reason);await reader.cancel(reason);}});
      return new Response(stream,{status:response.status,headers});
    };
    if (request.signal.aborted) return deny('Request already cancelled',499);
    if (config.mode==='off' || config.killSwitch==='bypass' || request.method!=='POST' || !endpoints.has(endpoint)) {
      if (only) return deny('Local-only request cannot be handled by this policy mode or endpoint');
      event('bypass'); return passthrough(outgoing(request,request.body,request.signal));
    }
    // A bounded reader avoids tee()/clone() retaining unbounded request bodies.
    const reader=request.body?.getReader(), chunks=[]; let size=0;
    if(reader) while(true) {
      const {done,value}=await reader.read();if(done)break;size+=value.byteLength;chunks.push(value);
      if(size>config.cache.maxRequestBytes){
        if(only){await reader.cancel();return deny('Request exceeds local-only body limit',413);}
        event('ineligible',{reason:'request_over_inspection_limit',token_savings:null});
        let index=0;
        const uninspected=new ReadableStream({async pull(c){try{if(index<chunks.length){c.enqueue(chunks[index++]);return;}const part=await reader.read();if(part.done)c.close();else c.enqueue(part.value);}catch(e){c.error(e);}},async cancel(reason){await reader.cancel(reason);}});
        return passthrough(outgoing(request,uninspected,request.signal));
      }
    }
    const raw=Buffer.concat(chunks,size); let body;
    this.refresh();
    if (this.epoch!==epoch) return this.handle(new Request(request.url,{method:request.method,headers:request.headers,body:raw,signal:request.signal,duplex:'half'}),delegate);
    try {body=JSON.parse(raw.toString('utf8'));} catch {
      if(only)return deny('Invalid JSON request',400);
      event('ineligible',{reason:'invalid_json'});return passthrough(outgoing(request,raw,request.signal));
    }
    if (!body || typeof body!=='object' || Array.isArray(body)) {
      if(only)return deny('Expected JSON object',400);
      event('ineligible',{reason:'non_object_json'});return passthrough(outgoing(request,raw,request.signal));
    }
    const proposal=request.headers.get('x-relay-optimizer')==='off' ? {body,changes:[]} : optimize(body,request.headers,config,this.secret,endpoint);
    const reason=eligibility(body,request.headers,endpoint,config,this.now());
    const digestHeaders=[...request.headers].filter(([key])=>!hop.has(key) && key!=='x-relay-local-only').sort(([a],[b])=>a.localeCompare(b));
    const key=reason ? null : createHmac('sha256',this.secret).update(JSON.stringify([this.revision,request.url,digestHeaders])).update(raw).digest('hex');
    const entry=key ? this.get(key) : null;
    if (entry && config.mode==='enforce') {
      this.counters.local_hits++;event('local_hit',{upstream_requests:0,billable_tokens:0,original_usage:entry.replay.originalUsage});
      const headers=new Headers({'content-type':entry.type,'cache-control':'no-store','x-relay-cache':'hit','x-relay-policy-mode':'enforce','x-relay-policy-revision':this.revision,'x-relay-upstream-requests':'0','x-relay-billable-tokens':'0','x-relay-usage-source':'local-cache'});
      return new Response(replayBytes(entry.replay,endpoint),{status:200,headers});
    }
    if (entry) this.counters.shadow_hits++;
    if (only) return deny('No eligible local result; upstream is forbidden for this request');
    const wire=config.mode==='enforce' && proposal.changes.length ? Buffer.from(JSON.stringify(proposal.body)) : raw;
    event(entry?'would_hit':reason?'ineligible':'miss',{reason,proposed_changes:proposal.changes,applied:config.mode==='enforce',input_bytes:raw.length,proposed_bytes:Buffer.byteLength(JSON.stringify(proposal.body)),token_savings:null});
    const response=await passthrough(outgoing(request,wire,request.signal));
    const headers=new Headers(response.headers); headers.set('x-relay-cache',entry?'would-hit':reason?'bypass':'miss');
    if (!key || !response.ok || response.status!==200 || !response.body || response.headers.has('set-cookie') || /no-store/i.test(response.headers.get('cache-control')??'')) return new Response(response.body,{status:response.status,headers});
    const type=response.headers.get('content-type')??'', responseReader=response.body.getReader();
    let length=0,parts=[],cancelled=false;
    const engine=this, expires=Math.min(this.now()+config.cache.ttlMs,authDeadline(request.headers,this.now()));
    const stream=new ReadableStream({
      async pull(c) {
        try {
          const {done,value}=await responseReader.read();
          if(cancelled)return;
          if(done) {
            if (length<=config.cache.maxEntryBytes && !request.signal.aborted) {
              const replay=inspectReplay(Buffer.concat(parts,length),type,endpoint);
              if(replay) {
                // Charge parsed representation too, not only wire bytes, against the memory budget.
                const storedSize=Buffer.byteLength(JSON.stringify(replay));
                engine.put(key,{replay,type,expires,size:storedSize},epoch);
              } else engine.counters.rejected_responses++;
            }
            parts=[];c.close();return;
          }
          length+=value.byteLength;
          if(length<=config.cache.maxEntryBytes)parts.push(Buffer.from(value));else parts=[];
          c.enqueue(value);
        }catch(error){parts=[];engine.counters.rejected_responses++;c.error(error);}
      }, async cancel(reason){cancelled=true;parts=[];await responseReader.cancel(reason);}
    });
    return new Response(stream,{status:response.status,headers});
  }
}
