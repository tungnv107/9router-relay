import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the actual route/provider/config without touching the operator's DB.
vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));

const CALLBACK = "http://localhost:20128/callback";
let upstreamFetch;
const PROVIDERS = [
  { provider: "antigravity", prefix: "ANTIGRAVITY_OAUTH", label: "Antigravity" },
  { provider: "gemini-cli", prefix: "GOOGLE_OAUTH", label: "Gemini CLI" },
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const { prefix } of PROVIDERS) {
    vi.stubEnv(`${prefix}_CLIENT_ID`, "");
    vi.stubEnv(`${prefix}_CLIENT_SECRET`, "");
    vi.stubEnv(`${prefix}_REDIRECT_URI`, "");
  }
  upstreamFetch = vi.fn();
  vi.stubGlobal("fetch", upstreamFetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(PROVIDERS)("$label OAuth configuration", ({ provider, prefix, label }) => {
  it.each([
    { name: "both credentials missing", id: "", secret: "", missing: ["ID", "SECRET"] },
    { name: "client ID missing", id: "", secret: "fixture-secret", missing: ["ID"] },
    { name: "client secret missing", id: "fixture-id", secret: "", missing: ["SECRET"] },
    { name: "whitespace client ID", id: " \t ", secret: "fixture-secret", missing: ["ID"] },
    { name: "whitespace client secret", id: "fixture-id", secret: " \n ", missing: ["SECRET"] },
  ])("returns an actionable 503 for $name without an auth URL", async ({ id, secret, missing }) => {
    vi.stubEnv(`${prefix}_CLIENT_ID`, id);
    vi.stubEnv(`${prefix}_CLIENT_SECRET`, secret);
    const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
    const response = await GET(new Request(`http://localhost/api/oauth/${provider}/authorize`), {
      params: Promise.resolve({ provider, action: "authorize" }),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.authUrl).toBeUndefined();
    expect(body.error).toContain(`${label} OAuth is not configured`);
    for (const suffix of ["ID", "SECRET"]) {
      if (missing.includes(suffix)) expect(body.error).toContain(`${prefix}_CLIENT_${suffix}`);
      else expect(body.error).not.toContain(`${prefix}_CLIENT_${suffix}`);
    }
    expect(body.error).toContain("recreate the Docker container");
    expect(body.error).not.toContain("fixture-secret");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("uses runtime credentials in a complete auth URL without exposing the secret", async () => {
    vi.stubEnv(`${prefix}_CLIENT_ID`, " fixture-id.apps.googleusercontent.com ");
    vi.stubEnv(`${prefix}_CLIENT_SECRET`, " fixture-secret ");
    const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
    const response = await GET(new Request(
      `http://localhost/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}`
    ), { params: Promise.resolve({ provider, action: "authorize" }) });
    const body = await response.json();
    const url = new URL(body.authUrl);

    expect(response.status).toBe(200);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("fixture-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("state")).toBe(body.state);
    expect(body.state).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("blocks token exchange before any upstream request or connection save when unconfigured", async () => {
    const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
    const { createProviderConnection } = await import("@/models");
    const response = await POST(new Request(`http://localhost/api/oauth/${provider}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "fixture-code", redirectUri: CALLBACK, codeVerifier: "fixture-verifier", state: "fixture-state" }),
    }), { params: Promise.resolve({ provider, action: "exchange" }) });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain(`${prefix}_CLIENT_ID`);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("uses the same trimmed client pair when exchanging a code", async () => {
    vi.stubEnv(`${prefix}_CLIENT_ID`, " fixture-id ");
    vi.stubEnv(`${prefix}_CLIENT_SECRET`, " fixture-secret ");
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture-access-token" })));
    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const handler = getProvider(provider);
    const result = await handler.exchangeToken(handler.config, "fixture-code", CALLBACK);
    const [url, options] = upstreamFetch.mock.calls[0];

    expect(result.access_token).toBe("fixture-access-token");
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(options.method).toBe("POST");
    expect(options.body.get("client_id")).toBe("fixture-id");
    expect(options.body.get("client_secret")).toBe("fixture-secret");
    expect(options.body.get("code")).toBe("fixture-code");
    expect(options.body.get("redirect_uri")).toBe(CALLBACK);
  });

  it("uses the registered web callback for authorization and exchange, overriding loopback input", async () => {
    const webCallback = "https://router.example/api/auth/callback/google";
    vi.stubEnv(`${prefix}_CLIENT_ID`, "fixture-web-id");
    vi.stubEnv(`${prefix}_CLIENT_SECRET`, "fixture-web-secret");
    vi.stubEnv(`${prefix}_REDIRECT_URI`, ` ${webCallback} `);
    const { generateAuthData, exchangeTokens } = await import("../../src/lib/oauth/providers.js");
    vi.stubGlobal("fetch", upstreamFetch);
    const auth = await generateAuthData(provider, CALLBACK);
    expect(auth.redirectUri).toBe(webCallback);
    expect(new URL(auth.authUrl).searchParams.get("redirect_uri")).toBe(webCallback);

    upstreamFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: "fixture@example.com" })))
      .mockResolvedValueOnce(new Response("{}"));
    const tokens = await exchangeTokens(provider, "fixture-code", CALLBACK, auth.codeVerifier, auth.state);
    expect(tokens.accessToken).toBe("fixture-token");
    expect(upstreamFetch.mock.calls[0][1].body.get("redirect_uri")).toBe(webCallback);
  });
});

it("preserves the status of unrelated OAuth failures", async () => {
  const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
  const response = await GET(new Request("http://localhost/api/oauth/unknown/authorize"), {
    params: Promise.resolve({ provider: "unknown", action: "authorize" }),
  });
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe("Unknown provider: unknown");
});
