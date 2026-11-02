"use client";

import Input from "./Input";

export default function ChRelayFields({ value, onChange }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <Input label="ch-relay Base URL" value={value.baseUrl || ""}
        placeholder="Leave blank to use the server's configured relay"
        onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} />
      <Input label="ChatGPT Account ID (optional)" value={value.chatgptAccountId || ""}
        onChange={(event) => onChange({ ...value, chatgptAccountId: event.target.value })} />
      <p className="text-xs text-text-muted">
        Use the inference port of your running local proxy. Enter its share key or a valid ChatGPT access token below.
        Check verifies model discovery; authentication is verified on inference. Exact response caching requires
        X-Relay-Cache: allow and X-Relay-Cache-Scope. Tools and conversation state bypass response caching.
      </p>
    </div>
  );
}
