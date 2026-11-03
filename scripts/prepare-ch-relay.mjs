// Package the user's existing backend privately; do not commit its recovered bundle or data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/prepare-ch-relay.mjs <ch-relay-local directory>");
const sourceRoot = path.resolve(input);
const output = path.join(root, "vendor", "ch-relay");
const hash = content => crypto.createHash("sha256").update(content).digest("hex");
let source = fs.readFileSync(path.join(sourceRoot, "src", "entry.local.js"), "utf8");
const sourceHash = hash(source);
if (sourceHash !== "ce265ce6b3ccd36a1b80e0506e0ae9505fdd0afc174888594f7af9af2bb73015") {
  throw new Error("Unexpected backend source; review compatibility before packaging a new revision");
}
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
const files = {
  "index-8p0jyy0b.html": "src/index.local.html",
  "chunk-2q8tsrp3.js": "src/ui.local.js",
  "chunk-rgssp4v7.css": "recovered/chunk-rgssp4v7.css",
  "house-rules-1s5hvfbv.md": "recovered/house-rules-1s5hvfbv.md",
  "customer-guide-xwzb5nrc.html": "recovered/customer-guide-xwzb5nrc.html",
  "share-install-n3xw65bq.ps1": "recovered/share-install-n3xw65bq.ps1",
  "share-uninstall-e627c9f9.ps1": "recovered/share-uninstall-e627c9f9.ps1",
  "share-install-5089j8p7.sh": "recovered/share-install-5089j8p7.sh",
  "share-uninstall-2kx8tghv.sh": "recovered/share-uninstall-2kx8tghv.sh",
};
const assetHashes = {};
for (const [name, relative] of Object.entries(files)) {
  const contents = fs.readFileSync(path.join(sourceRoot, relative));
  assetHashes[name] = hash(contents);
  fs.writeFileSync(path.join(output, "assets", name), contents);
}
const worker = fs.readFileSync(path.join(sourceRoot, "recovered", "stats", "worker.js"));
fs.writeFileSync(path.join(output, "worker.js"), worker);
assetHashes["worker.js"] = hash(worker);

// Bun executable asset references are not filesystem paths when running source on Linux.
source = source.replace(/TW\("B:\/~BUN\/root\/([^"/]+)"\)/g, (_, name) => {
  if (!files[name]) throw new Error(`Unmapped asset: ${name}`);
  return `__relayReadAsset(${JSON.stringify(name)})`;
});
const manifest = source.match(/^  Ni = q8\('[^\n]+'\);$/m);
if (!manifest) throw new Error("Embedded HTML manifest changed");
source = source.replace(manifest[0], '  Ni = () => new Response(Bun.file(new URL("./assets/index-8p0jyy0b.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });');
if (source.includes("B:/~BUN/root/")) throw new Error("Unmapped executable asset remains");

// Copy the reviewed native Google adapter alongside the private backend. Keep
// relative imports intact so this package does not need the 9router source tree.
for (const relative of ["config/antigravityRelay.mjs", "services/chRelay/googleGateway.mjs"]) {
  const contents = fs.readFileSync(path.join(root, "open-sse", relative));
  fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
  fs.writeFileSync(path.join(output, relative), contents);
  assetHashes[relative] = hash(contents);
}
const networkPolicy = 'return { enforced: true, allowedOrigins: ["https://chatgpt.com", "https://auth.openai.com"], redirects: "error", environmentProxy: false, vendorServices: false };';
if (!source.includes(networkPolicy)) throw new Error("Backend network policy metadata changed");
source = source.replace(networkPolicy, networkPolicy.replace("return {", "return __relayNetworkPolicy({").replace("};", "});"));

// Existing OpenAI routes keep their original auth and outbound restrictions.
const bootstrap = `
import { readFileSync as __relayReadFile } from "node:fs";
import { withAntigravityRoutes as __relayGoogleRoutes, withAntigravityNetworkPolicy as __relayNetworkPolicy } from "./services/chRelay/googleGateway.mjs";
const __relayReadAsset = name => __relayReadFile(new URL("./assets/" + name, import.meta.url), "utf8");
const __relayServe = Bun.serve.bind(Bun);
const __relayPorts = new Set([process.env.CH_PORT, process.env.CH_SHARE_PORT, process.env.CH_ADMIN_PORT].map(Number).filter(n => n > 0));
Bun.serve = options => {
  if (__relayPorts.has(Number(options.port))) {
    options = { ...options, hostname: process.env.CH_RELAY_BIND_HOST || "0.0.0.0" };
    if (Number(options.port) === Number(process.env.CH_SHARE_PORT)) options = __relayGoogleRoutes(options);
    if (options.routes && Number(options.port) === Number(process.env.CH_ADMIN_PORT)) {
      options.routes = { ...options.routes };
      for (const [name, type] of [["chunk-2q8tsrp3.js", "text/javascript"], ["chunk-rgssp4v7.css", "text/css"]]) {
        options.routes["/" + name] = () => new Response(Bun.file(new URL("./assets/" + name, import.meta.url)), { headers: { "content-type": type } });
      }
    }
  }
  return __relayServe(options);
};
`;
source = bootstrap + source;
fs.writeFileSync(path.join(output, "entry.mjs"), source);
const provenance = { source: "ch-relay-local 1.1.96 OpenAI-only bundle", sourceSha256: sourceHash, packagedSha256: hash(source), assets: assetHashes, changes: ["Executable assets to filesystem", "Explicit Docker service ports bind 0.0.0.0", "Admin static asset routes", "Native Antigravity Google OAuth transport on inference port; original OpenAI guard unchanged"], credentialsIncluded: false };
fs.writeFileSync(path.join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
console.log(`Prepared private Docker context: ${output}\nSource SHA-256: ${sourceHash}`);
