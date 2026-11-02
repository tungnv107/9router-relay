import { createHmac } from 'node:crypto';

export function optimize(original, headers, config, secret, endpoint) {
  const body = structuredClone(original), changes = [];
  if (config.context.deduplicateTools && Array.isArray(body.tools)) {
    const seen = new Set();
    body.tools = body.tools.filter(tool => { const key=JSON.stringify(tool); if (seen.has(key)) { changes.push('duplicate_tool_removed'); return false; } seen.add(key); return true; });
  }
  const budget = config.context.maxToolOutputChars;
  if (budget && headers.get('x-relay-context') === 'truncate-tool-output') {
    const shorten = text => {
      if (typeof text !== 'string' || text.length <= budget) return text;
      const marker='\n[LOCAL POLICY: tool output truncated; request full output if needed]\n';
      const count=Math.floor((budget-marker.length)/2);
      changes.push('tool_output_truncated'); return text.slice(0,count)+marker+text.slice(-count);
    };
    if (Array.isArray(body.input)) for (const item of body.input) if (item?.type === 'function_call_output') item.output=shorten(item.output);
    if (Array.isArray(body.messages)) for (const item of body.messages) if (item?.role === 'tool') item.content=shorten(item.content);
  }
  const scope=headers.get('x-relay-cache-scope');
  if (config.promptCache.enabled && config.promptCache.models.includes(body.model) && scope && !Object.hasOwn(body,'prompt_cache_key')) {
    // Scope is explicitly chosen by the caller; history remains byte-for-byte in order.
    const prefix=JSON.stringify([headers.get('authorization'),headers.get('chatgpt-account-id'),headers.get('x-relay-principal'),scope,body.model,body.instructions??body.messages?.filter(m=>['system','developer'].includes(m.role))??null,body.tools??null]);
    body.prompt_cache_key='local-v1-'+createHmac('sha256',secret).update(prefix).digest('hex');
    changes.push('prompt_cache_key_added');
  }
  const rule=config.reasoning.models[body.model];
  if (rule) {
    const chat=endpoint === '/v1/chat/completions';
    const current=chat ? body.reasoning_effort : body.reasoning?.effort;
    let effort=current;
    if (current === undefined && rule.defaultEffort) effort=rule.defaultEffort;
    else if (rule.allowExplicitDowngrade && headers.get('x-relay-reasoning') === 'allow-downgrade' && rule.maxEffort && rule.supported.includes(current) && rule.supported.indexOf(current)>rule.supported.indexOf(rule.maxEffort)) effort=rule.maxEffort;
    if (effort !== current) {
      if (chat) body.reasoning_effort=effort; else body.reasoning={...body.reasoning,effort};
      changes.push(current === undefined ? 'reasoning_default_set' : 'reasoning_effort_capped');
    }
  }
  return {body,changes};
}
