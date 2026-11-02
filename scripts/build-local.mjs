// Keep build-time provider discovery/tracing away from the operator's live profile.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".scratch");
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, "build-profile-"));
for (const dir of ["AppData/Roaming", "AppData/Local", "data"]) fs.mkdirSync(path.join(profile, dir), { recursive: true });
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATA_DIR: path.join(profile, "data"), CIRCLE_NODE_TOTAL: "2" };
if (process.platform === "win32") Object.assign(env, {
  USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
});
for (const args of [["node_modules/next/dist/bin/next", "build", "--webpack"], ["scripts/copy-standalone-assets.mjs"]]) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: "inherit" });
  const [code] = await once(child, "exit");
  if (code !== 0) { process.exitCode = code || 1; break; }
}
