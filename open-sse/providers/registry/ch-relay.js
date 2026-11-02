export default {
  id: "ch-relay",
  alias: "chr",
  priority: 31,
  category: "apikey",
  display: {
    name: "ch-relay Local",
    icon: "hub",
    color: "#0D9488",
    textIcon: "CH",
    notice: {
      text: "Optional manual relay connection for a separate share key or backend. OpenAI Codex connections already route chat and Responses through the server's ch-relay automatically; no extra connection is needed. Exact response caching is opt-in; tools and conversation state bypass it.",
    },
  },
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "http://127.0.0.1:11500/v1/chat/completions",
    format: "openai",
  },
  transports: [
    { format: "openai", baseUrl: "http://127.0.0.1:11500/v1/chat/completions" },
    { format: "openai-responses", baseUrl: "http://127.0.0.1:11500/v1/responses" },
  ],
  models: [
    { id: "gpt-6-luna", name: "GPT 6.0 Luna (ch-relay)" },
    { id: "gpt-6-sol", name: "GPT 6.0 Sol (ch-relay)" },
    { id: "gpt-6-astra", name: "GPT 6.0 Astra (ch-relay)" },
  ],
};
