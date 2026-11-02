import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readChRelayPolicy } from "../../open-sse/services/chRelay/runtime.js";
import { ChRelayExecutor } from "../../open-sse/executors/ch-relay.js";
import { PolicyEngine } from "../../open-sse/services/chRelay/policy/engine.mjs";
import { chRelayDefaults } from "../../open-sse/services/chRelay/runtime.js";

describe("ch-relay runtime controls", () => {
  const dirs = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(dir).startsWith("9r-ch-policy-")) throw new Error("Unexpected test cleanup path");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fails closed for missing or invalid configured policy and reloads repairs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-ch-policy-")); dirs.push(dir);
    const filename = path.join(dir, "policy.json");
    vi.stubEnv("CH_RELAY_POLICY_FILE", filename);
    vi.stubEnv("CH_RELAY_POLICY_KILL", "");
    expect(readChRelayPolicy().killSwitch).toBe("block");
    fs.writeFileSync(filename, "broken");
    expect(readChRelayPolicy().killSwitch).toBe("block");
    fs.writeFileSync(filename, JSON.stringify(chRelayDefaults));
    expect(readChRelayPolicy().mode).toBe("enforce");
    expect(readChRelayPolicy().killSwitch).toBe("none");
    fs.writeFileSync(path.join(dir, "KILL_SWITCH"), "block");
    expect(readChRelayPolicy().killSwitch).toBe("block");
    vi.stubEnv("CH_RELAY_POLICY_KILL", "bypass");
    expect(readChRelayPolicy().killSwitch).toBe("bypass");
  });
  it("observes kill=block while the relay is still processing a request", async () => {
    const config = structuredClone(chRelayDefaults);
    const policy = new PolicyEngine({ readConfig: () => config });
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const executor = new ChRelayExecutor({ policy, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); entered();
    }) });
    const pending = executor.execute({ model: "fixture", stream: false, body: { messages: [{ role: "user", content: "test" }] }, credentials: { apiKey: "fixture" } });
    const rejected = expect(pending).rejects.toThrow("kill switch");
    await ready; config.killSwitch = "block";
    await rejected;
    expect(policy.active.size).toBe(0);
  });
});
