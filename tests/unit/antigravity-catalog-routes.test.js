import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connection: { id: "ag-account", provider: "antigravity", isActive: true, accessToken: "fixture", projectId: "fixture-project" },
}));
vi.mock("@/models", () => ({ getProviderConnectionById: vi.fn(async () => state.connection) }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [state.connection]),
  getProviderConnectionById: vi.fn(async () => state.connection),
  getCombos: vi.fn(async () => []), getCustomModels: vi.fn(async () => []), getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  filterModelsListForKey: vi.fn((_context, models) => models),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(), refreshCodexToken: vi.fn(), updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/antigravityModels.js", () => ({ resolveAntigravityModels: vi.fn() }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: vi.fn(async () => ({ success: true })) }));

import { resolveAntigravityModels } from "open-sse/services/antigravityModels.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { pingModelByKind } from "@/app/api/models/test/ping";
import { GET as providerModels } from "@/app/api/providers/[id]/models/route.js";
import { GET as publicModels } from "@/app/api/v1/models/route.js";
import { POST as testModels } from "@/app/api/providers/[id]/test-models/route.js";

const context = { params: Promise.resolve({ id: "ag-account" }) };
const request = () => new Request("http://localhost/v1/models");
const live = [{ id: "gemini-live", name: "Gemini Live", kind: "llm" }, { id: "image-live", name: "Image", kind: "image" }];
beforeEach(() => {
  vi.clearAllMocks();
  delete state.connection.providerSpecificData;
  resolveAntigravityModels.mockResolvedValue({ models: live });
});

describe("Antigravity catalogs across API consumers", () => {
  it("returns live models to the provider page and persists refreshed credentials", async () => {
    const response = await providerModels(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual(live);
    const [, options] = resolveAntigravityModels.mock.calls[0];
    await options.onCredentialsRefreshed({ accessToken: "new" });
    expect(updateProviderCredentials).toHaveBeenCalledWith("ag-account", { accessToken: "new" });
  });

  it("exposes only live Antigravity models through the OpenAI model list", async () => {
    const response = await publicModels(request());
    const models = (await response.json()).data.filter(m => m.id.startsWith("ag/"));
    expect(models.map(m => m.id)).toEqual(["ag/gemini-live"]);
  });

  it("intersects an explicit allowlist with the live catalog", async () => {
    state.connection.providerSpecificData = { enabledModels: ["ag/gemini-live", "retired-model"] };
    const response = await publicModels(request());
    expect((await response.json()).data.filter(m => m.id.startsWith("ag/")).map(m => m.id)).toEqual(["ag/gemini-live"]);
  });

  it("does not advertise static models or run inference when discovery fails", async () => {
    resolveAntigravityModels.mockResolvedValue({ models: [], error: "Discovery failed", status: 503 });
    expect((await providerModels(request(), context)).status).toBe(503);
    const models = (await (await publicModels(request())).json()).data;
    expect(models.filter(m => m.id.startsWith("ag/"))).toEqual([]);
    expect((await testModels(request(), context)).status).toBe(503);
    expect(pingModelByKind).not.toHaveBeenCalled();
  });

  it("tests only live models, preserving each model's service kind", async () => {
    expect((await testModels(request(), context)).status).toBe(200);
    expect(pingModelByKind.mock.calls.map(([model, kind]) => [model, kind])).toEqual([["ag/gemini-live", "llm"], ["ag/image-live", "image"]]);
  });
});
