import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const defaults = {
  version: 1, mode: 'dry-run', killSwitch: 'none',
  cache: { enabled: true, requireOptIn: true, ttlMs: 300000, maxEntries: 128, maxBytes: 16777216, maxEntryBytes: 2097152, maxRequestBytes: 2097152 },
  promptCache: { enabled: false, models: [] },
  context: { deduplicateTools: false, maxToolOutputChars: 0 },
  reasoning: { models: {} },
  audit: { enabled: true, maxBytes: 2097152 }
};
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function keys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(k => !allowed.includes(k))) throw Error('Invalid fields: ' + label);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid ' + label);
}
export function validateConfig(input) {
  keys(input, Object.keys(defaults), 'config');
  const value = structuredClone(defaults);
  for (const [k,v] of Object.entries(input)) value[k] = record(v) ? { ...value[k], ...v } : v;
  if (value.version !== 1 || !['off','dry-run','enforce'].includes(value.mode) || !['none','bypass','block'].includes(value.killSwitch)) throw Error('Invalid version, mode or killSwitch');
  for (const k of ['cache','promptCache','context','reasoning','audit']) keys(value[k], Object.keys(defaults[k]), k);
  for (const [obj,field] of [['cache','enabled'],['cache','requireOptIn'],['promptCache','enabled'],['context','deduplicateTools'],['audit','enabled']]) {
    if (typeof value[obj][field] !== 'boolean') throw Error('Invalid ' + obj + '.' + field);
  }
  for (const [field,min,max] of [['ttlMs',1,3600000],['maxEntries',1,10000],['maxBytes',1024,268435456],['maxEntryBytes',512,16777216],['maxRequestBytes',512,16777216]]) integer(value.cache[field],min,max,field);
  if (value.cache.maxEntryBytes > value.cache.maxBytes) throw Error('Entry exceeds total cache budget');
  integer(value.context.maxToolOutputChars,0,1000000,'maxToolOutputChars');
  if (value.context.maxToolOutputChars > 0 && value.context.maxToolOutputChars < 256) throw Error('Tool output budget must be >=256');
  integer(value.audit.maxBytes,1024,67108864,'audit.maxBytes');
  if (!Array.isArray(value.promptCache.models) || value.promptCache.models.some(x => typeof x !== 'string' || !x)) throw Error('Invalid prompt-cache models');
  if (!record(value.reasoning.models)) throw Error('Invalid reasoning models');
  for (const [model,rule] of Object.entries(value.reasoning.models)) {
    if (!model || model.length > 200) throw Error('Invalid model');
    keys(rule,['supported','defaultEffort','maxEffort','allowExplicitDowngrade'],'reasoning rule');
    if (!Array.isArray(rule.supported) || !rule.supported.length || new Set(rule.supported).size !== rule.supported.length || rule.supported.some(x=>!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(x))) throw Error('Invalid supported efforts');
    for (const k of ['defaultEffort','maxEffort']) if (rule[k] !== undefined && !rule.supported.includes(rule[k])) throw Error('Unsupported effort');
    if (rule.allowExplicitDowngrade !== undefined && typeof rule.allowExplicitDowngrade !== 'boolean') throw Error('Invalid allowExplicitDowngrade');
  }
  return value;
}
export const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
export function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temporary,filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export class FileControl {
  constructor(filename, env = process.env) { this.filename = filename; this.env = env; this.error = null; }
  read() {
    try {
      const value = validateConfig(fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename,'utf8')) : defaults);
      const sentinel = path.join(path.dirname(this.filename),'KILL_SWITCH');
      const kill = this.env.CH_LOCAL_POLICY_KILL || (fs.existsSync(sentinel) ? fs.readFileSync(sentinel,'utf8').trim() : '');
      if (kill) value.killSwitch = kill === 'bypass' ? 'bypass' : 'block';
      this.error = null;
      return value;
    } catch { this.error = 'Invalid or unreadable policy; requests blocked until repaired'; return {...structuredClone(defaults),killSwitch:'block'}; }
  }
  write(value) {
    value = validateConfig(value);
    // Validate the current file before replacing it; never save a broken rollback point.
    const previous = fs.existsSync(this.filename) ? validateConfig(JSON.parse(fs.readFileSync(this.filename,'utf8'))) : structuredClone(defaults);
    atomicWrite(this.filename+'.previous',previous);
    atomicWrite(this.filename,value);
    return value;
  }
  rollback() { return this.write(JSON.parse(fs.readFileSync(this.filename+'.previous','utf8'))); }
}
