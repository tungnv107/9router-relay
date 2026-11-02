import fs from "node:fs";
import { PolicyEngine } from "./policy/engine.mjs";
import { defaults, FileControl, validateConfig } from "./policy/config.mjs";

export const chRelayDefaults = validateConfig({
  ...structuredClone(defaults),
  mode: "enforce",
  context: { deduplicateTools: true, maxToolOutputChars: 0 },
});

export function readChRelayPolicy() {
  const filename = process.env.CH_RELAY_POLICY_FILE;
  // An explicitly configured missing file must not silently re-enable upstream access.
  let config = filename
    ? (fs.existsSync(filename) ? new FileControl(filename).read() : { ...chRelayDefaults, killSwitch: "block" })
    : structuredClone(chRelayDefaults);
  const kill = process.env.CH_RELAY_POLICY_KILL;
  if (kill) config = { ...config, killSwitch: kill === "bypass" ? "bypass" : "block" };
  return config;
}

let engine;
export function getChRelayPolicy() {
  if (!engine) engine = new PolicyEngine({ readConfig: readChRelayPolicy });
  return engine;
}
