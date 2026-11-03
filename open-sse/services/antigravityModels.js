import { createHash } from "node:crypto";
import antigravity from "../providers/registry/antigravity.js";
import { ANTIGRAVITY_CATALOG } from "../config/antigravityCatalog.js";
import { refreshGoogleToken } from "./tokenRefresh/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const cache = new Map();
const pending = new Map();
const keyFor = credentials => createHash("sha256").update(JSON.stringify([
  credentials.accessToken, credentials.projectId || credentials.providerSpecificData?.projectId,
])).digest("hex");

// Google model enum values and experimental prompts are not public model IDs.
// Use the map keys selected by Google's agent/image pickers, retaining only
// metadata the dashboard needs. Never return the raw catalog to clients.
export function normalizeAntigravityModels(data) {
  const entries = Array.isArray(data?.models)
    ? data.models.map(info => [info.id, info])
    : Object.entries(data?.models || {});
  const agentIds = (data?.agentModelSorts || []).flatMap(sort => (sort.groups || []).flatMap(group => group.modelIds || []));
  const imageIds = new Set(data?.imageGenerationModelIds || []);
  const visibleIds = new Set([...agentIds, ...imageIds]);
  return entries.filter(([id, info]) => typeof id === "string" && id && info &&
    !info.isInternal && !info.disabled && !info.isDisabled && !info.isHidden &&
    (visibleIds.size ? visibleIds.has(id) : !!(info.displayName || info.name)))
    .map(([id, info]) => ({
      id, name: info.displayName || info.name || id,
      kind: imageIds.has(id) ? "image" : "llm",
      contextLength: info.maxTokens,
      maxOutputTokens: info.maxOutputTokens,
      supportsImages: info.supportsImages === true,
      supportsThinking: info.supportsThinking === true,
    }));
}

export async function resolveAntigravityModels(credentials, {
  fetchImpl = proxyAwareFetch, refreshImpl = refreshGoogleToken,
  onCredentialsRefreshed, proxyOptions = null, forceRefresh = false,
} = {}) {
  if (!credentials?.accessToken) return { models: [], error: "Antigravity requires a Google access token", status: 401 };
  const key = keyFor(credentials);
  const cached = cache.get(key);
  if (!forceRefresh && cached?.expiresAt > Date.now()) return structuredClone(cached.result);
  if (pending.has(key)) return structuredClone(await pending.get(key));
  const task = (async () => {
    let current = { ...credentials };
    const fetchCatalog = () => fetchImpl(antigravity.transport.usage.quotaApiUrl, {
      method: "POST", headers: {
        authorization: `Bearer ${current.accessToken}`, "content-type": "application/json",
        "user-agent": antigravity.transport.headers["User-Agent"],
      }, body: JSON.stringify({ project: current.projectId || current.providerSpecificData?.projectId }),
      signal: AbortSignal.timeout(ANTIGRAVITY_CATALOG.timeoutMs), redirect: "error",
    }, proxyOptions);
    try {
      let response = await fetchCatalog();
      if (response.status === 401 && current.refreshToken && onCredentialsRefreshed) {
        await response.body?.cancel();
        const refreshed = await refreshImpl(current.refreshToken, antigravity.transport.clientId, antigravity.transport.clientSecret);
        if (!refreshed?.accessToken) return { models: [], error: "Antigravity Google token refresh failed", status: 401 };
        await onCredentialsRefreshed(refreshed);
        current = { ...current, ...refreshed };
        response = await fetchCatalog();
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { models: [], error: `Antigravity model discovery failed (Google HTTP ${response.status})`, status: response.status };
      }
      const models = normalizeAntigravityModels(await response.json());
      if (!models.length) return { models: [], error: "Google returned no available Antigravity models for this account", status: 502 };
      const result = { models };
      for (const [entryKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(entryKey);
      if (cache.size >= ANTIGRAVITY_CATALOG.maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(keyFor(current), { result, expiresAt: Date.now() + ANTIGRAVITY_CATALOG.cacheTtlMs });
      return result;
    } catch {
      return { models: [], error: "Cannot load the Antigravity model catalog from Google", status: 502 };
    }
  })();
  pending.set(key, task);
  try { return structuredClone(await task); } finally { pending.delete(key); }
}
