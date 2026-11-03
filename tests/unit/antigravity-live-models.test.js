import { describe, expect, it, vi } from "vitest";
import { normalizeAntigravityModels, resolveAntigravityModels } from "../../open-sse/services/antigravityModels.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const catalog = {
  models: {
    "gemini-live": { displayName: "Gemini Live", model: "PRIVATE_ENUM", maxTokens: 1000000, supportsImages: true, modelExperiments: { prompt: "private" } },
    "image-live": { displayName: "Image Live" },
    "disabled-live": { displayName: "Disabled", disabled: true },
    "internal-live": { displayName: "Internal", isInternal: true },
    "tab-model": {},
    "legacy-model": { displayName: "Legacy" },
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-live", "disabled-live", "internal-live"] }] }],
  imageGenerationModelIds: ["image-live"],
};

describe("Antigravity account catalog", () => {
  it("uses public map keys and picker visibility without exposing internal metadata", () => {
    const models = normalizeAntigravityModels(catalog);
    expect(models.map(m => m.id)).toEqual(["gemini-live", "image-live"]);
    expect(models[0]).toMatchObject({ name: "Gemini Live", contextLength: 1000000, supportsImages: true, kind: "llm" });
    expect(models[1].kind).toBe("image");
    expect(JSON.stringify(models)).not.toMatch(/PRIVATE_ENUM|private|modelExperiments/);
  });

  it("handles a catalog without picker metadata while excluding hidden entries", () => {
    const models = normalizeAntigravityModels({ models: catalog.models });
    expect(models.map(m => m.id)).toEqual(["gemini-live", "image-live", "legacy-model"]);
    expect(normalizeAntigravityModels({})).toEqual([]);
  });

  it("fetches the quota catalog with Google credentials and deduplicates account-specific requests", async () => {
    const fetchImpl = vi.fn(async () => Response.json(catalog));
    const credentials = { accessToken: "catalog-cache", projectId: "project-one" };
    const [first, second] = await Promise.all([
      resolveAntigravityModels(credentials, { fetchImpl }),
      resolveAntigravityModels(credentials, { fetchImpl }),
    ]);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(antigravity.transport.usage.quotaApiUrl);
    expect(url).toContain(":fetchAvailableModels");
    expect(init.headers.authorization).toBe("Bearer catalog-cache");
    expect(JSON.parse(init.body)).toEqual({ project: "project-one" });
    expect(init.redirect).toBe("error");
    first.models.length = 0;
    expect((await resolveAntigravityModels(credentials, { fetchImpl })).models).toHaveLength(2);
    await resolveAntigravityModels({ ...credentials, projectId: "project-two" }, { fetchImpl });
    await resolveAntigravityModels({ accessToken: "another-account" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refreshes a rejected token once and persists it before retrying", async () => {
    const order = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockImplementationOnce(async (_url, init) => {
        order.push("retry");
        expect(init.headers.authorization).toBe("Bearer refreshed-token");
        return Response.json(catalog);
      });
    const refreshImpl = vi.fn(async () => ({ accessToken: "refreshed-token", expiresIn: 3600 }));
    const onCredentialsRefreshed = vi.fn(async () => order.push("persist"));
    const result = await resolveAntigravityModels({ accessToken: "expired-token", refreshToken: "refresh", providerSpecificData: { projectId: "project" } }, { fetchImpl, refreshImpl, onCredentialsRefreshed });
    expect(result.models).toHaveLength(2);
    expect(refreshImpl).toHaveBeenCalledWith("refresh", antigravity.transport.clientId, antigravity.transport.clientSecret);
    expect(order).toEqual(["persist", "retry"]);
  });

  it.each([401, 403, 404, 429, 500])("reports HTTP %i without exposing credentials or inventing static models", async status => {
    const fetchImpl = vi.fn(async () => new Response("secret upstream body", { status }));
    const result = await resolveAntigravityModels({ accessToken: `error-token-${status}` }, { fetchImpl });
    expect(result).toMatchObject({ models: [], status });
    expect(result.error).not.toMatch(/secret|token-/);
    await resolveAntigravityModels({ accessToken: `error-token-${status}` }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed for missing credentials, empty catalogs, network and invalid JSON errors", async () => {
    expect((await resolveAntigravityModels({})).status).toBe(401);
    for (const response of [Response.json({ models: {} }), new Response("invalid json")]) {
      expect(await resolveAntigravityModels({ accessToken: "invalid-catalog" }, { fetchImpl: async () => response })).toMatchObject({ models: [], status: 502 });
    }
    expect(await resolveAntigravityModels({ accessToken: "network-error" }, { fetchImpl: async () => { throw new Error("sensitive URL"); } })).toMatchObject({ models: [], status: 502 });
  });
});
