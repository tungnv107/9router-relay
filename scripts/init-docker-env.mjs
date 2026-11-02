import fs from "node:fs";
import crypto from "node:crypto";

const secret = () => crypto.randomBytes(32).toString("hex");
const values = {
  JWT_SECRET: secret(),
  INITIAL_PASSWORD: crypto.randomBytes(24).toString("base64url"),
  API_KEY_SECRET: secret(),
  MACHINE_ID_SALT: secret(),
  ROUTER_BIND_IP: "127.0.0.1",
  ROUTER_PORT: "20128",
  CH_RELAY_ADMIN_PORT: "11504",
  NPM_NETWORK: "npm_proxy",
  BASE_URL: "http://127.0.0.1:20128",
  ENABLE_REQUEST_LOGS: "false",
  OBSERVABILITY_ENABLED: "false",
  AUTH_COOKIE_SECURE: "false",
};
fs.writeFileSync(".env", Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
console.log("Created .env with random credentials. INITIAL_PASSWORD is the dashboard password. Keep this file private.");
