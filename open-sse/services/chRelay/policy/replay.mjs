import { randomUUID } from 'node:crypto';

const plainOutput = items => Array.isArray(items) && items.length > 0 && items.every(item=>
  item?.type === 'message' && item.role === 'assistant' && (!item.status || item.status === 'completed') && Array.isArray(item.content) && item.content.length > 0 &&
  item.content.every(p=>p?.type==='output_text' && typeof p.text==='string' && (!p.annotations || p.annotations.length===0)));
const plainChat = message => message?.role==='assistant' && typeof message.content==='string' && !message.tool_calls && !message.function_call && !message.refusal && !message.audio;
function safeUsage(usage) {
  if (!usage || typeof usage!=='object') return null;
  const result={};
  for (const key of ['input_tokens','output_tokens','total_tokens','prompt_tokens','completion_tokens']) if (Number.isFinite(usage[key]) && usage[key]>=0) result[key]=usage[key];
  for (const [group,field] of [['input_tokens_details','cached_tokens'],['output_tokens_details','reasoning_tokens'],['prompt_tokens_details','cached_tokens'],['completion_tokens_details','reasoning_tokens']]) if (Number.isFinite(usage[group]?.[field]) && usage[group][field]>=0) result[group]={[field]:usage[group][field]};
  return result;
}
function validResponse(response) { return response?.object==='response' && response.status==='completed' && !response.error && !response.incomplete_details && plainOutput(response.output); }
function sseFrames(text) {
  // An EOF without a blank-line event terminator is incomplete and must not be cached.
  if (!/\r?\n\r?\n$/.test(text)) return null;
  const frames=[];
  for (const block of text.replace(/\r\n/g,'\n').split('\n\n')) {
    if (!block.trim()) continue;
    const lines=block.split('\n'), data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
    if (!data) { frames.push({lines}); continue; }
    if (data==='[DONE]') { frames.push({lines,done:true}); continue; }
    try { frames.push({lines,json:JSON.parse(data)}); } catch { return null; }
  }
  return frames;
}
export function inspectReplay(bytes, type, endpoint) {
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if (type.includes('application/json')) {
      const json=JSON.parse(text);
      const ok=endpoint==='/v1/responses' ? validResponse(json) : json?.object==='chat.completion' && Array.isArray(json.choices) && json.choices.length>0 && json.choices.every(c=>c.finish_reason==='stop' && plainChat(c.message));
      return ok ? {json,originalUsage:safeUsage(json.usage)} : null;
    }
    if (!type.includes('text/event-stream')) return null;
    const frames=sseFrames(text); if (!frames) return null;
    let completed=null, done=false; const choices=new Map();
    const allowedEvents=new Set(['response.created','response.in_progress','response.output_item.added','response.content_part.added','response.output_text.delta','response.output_text.done','response.content_part.done','response.output_item.done','response.completed']);
    for (const f of frames) {
      if (f.done) { if(done)return null; done=true; continue; }
      const j=f.json; if (!j) continue;
      if(done)return null;
      if (j.error) return null;
      if (endpoint==='/v1/responses') {
        if (!allowedEvents.has(j.type) || (j.item && j.item.type!=='message') || (j.part && j.part.type!=='output_text')) return null;
        if (j.type==='response.completed') { if (!validResponse(j.response) || completed) return null; completed=j.response; }
        else if (completed) return null;
      } else {
        if (j.object!=='chat.completion.chunk' || !Array.isArray(j.choices)) return null;
        for (const c of j.choices) {
          if (!Number.isInteger(c.index) || c.delta?.tool_calls || c.delta?.function_call || c.delta?.refusal || c.delta?.audio || c.delta?.reasoning_content) return null;
          if (c.finish_reason && c.finish_reason!=='stop') return null;
          if (c.delta?.content !== undefined && typeof c.delta.content!=='string') return null;
          const previous=choices.get(c.index)??{text:false,finished:false};
          if (previous.finished && c.delta?.content) return null;
          choices.set(c.index,{text:previous.text || typeof c.delta?.content==='string',finished:previous.finished || c.finish_reason==='stop'});
        }
        if (j.usage) completed=j;
      }
    }
    const ok=endpoint==='/v1/responses' ? completed : done && choices.size>0 && [...choices.values()].every(c=>c.text && c.finished);
    return ok ? {frames,originalUsage:safeUsage(completed?.usage)} : null;
  } catch { return null; }
}
const zeroUsage = endpoint => endpoint==='/v1/responses' ? {input_tokens:0,input_tokens_details:{cached_tokens:0},output_tokens:0,output_tokens_details:{reasoning_tokens:0},total_tokens:0} : {prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:0}};
export function replayBytes(entry, endpoint) {
  const ids=new Map();
  const id = old => { if (!ids.has(old)) ids.set(old,(old.startsWith('msg_')?'msg_local_':old.startsWith('chatcmpl')?'chatcmpl-local-':'resp_local_')+randomUUID().replaceAll('-','')); return ids.get(old); };
  const rewrite = obj => {
    if (!obj || typeof obj!=='object') return;
    if (Object.hasOwn(obj,'usage')) obj.usage=zeroUsage(endpoint);
    for (const key of ['id','response_id','item_id']) if (typeof obj[key]==='string') obj[key]=id(obj[key]);
    if (typeof obj.created_at==='number') obj.created_at=Math.floor(Date.now()/1000);
    if (typeof obj.created==='number') obj.created=Math.floor(Date.now()/1000);
    for (const [key,value] of Object.entries(obj)) if (key!=='usage' && value && typeof value==='object') { if (Array.isArray(value)) value.forEach(rewrite); else rewrite(value); }
  };
  if (entry.json) { const json=structuredClone(entry.json); rewrite(json); return Buffer.from(JSON.stringify(json)); }
  return Buffer.from(entry.frames.map(f=> {
    if (!f.json) return f.lines.join('\n')+'\n\n';
    const json=structuredClone(f.json); rewrite(json);
    return f.lines.filter(x=>!x.startsWith('data:') && !x.startsWith('id:')).concat('data: '+JSON.stringify(json)).join('\n')+'\n\n';
  }).join(''));
}
