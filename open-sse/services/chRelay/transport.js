import { getChRelayPolicy } from "./runtime.js";

export function assertDirectChRelay(proxyOptions) {
  if (proxyOptions?.strictProxy || proxyOptions?.connectionProxyEnabled || proxyOptions?.vercelRelayUrl ||
      proxyOptions?.enabled || proxyOptions?.url || proxyOptions?.connectionProxyUrl || proxyOptions?.proxyPoolId) {
    throw new Error("ch-relay connects directly to its approved origin; remove this connection's outbound proxy setting");
  }
}

// Keep policy hot-reload active until the response finishes or is cancelled.
export async function handleChRelayRequest(request, delegate, policy = getChRelayPolicy()) {
  const monitor = setInterval(() => policy.refresh(), 100);
  monitor.unref?.();
  let response;
  try {
    response = await policy.handle(request, delegate);
  } catch (error) {
    clearInterval(monitor);
    throw error;
  }
  if (!response.body) {
    clearInterval(monitor);
    return response;
  }
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { clearInterval(monitor); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) { clearInterval(monitor); controller.error(error); }
    },
    async cancel(reason) { clearInterval(monitor); await reader.cancel(reason); },
  }), { status: response.status, headers: response.headers });
}
