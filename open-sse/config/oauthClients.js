// Supply Google OAuth app credentials at runtime; never publish them in this fork.
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: (process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "").trim(),
  clientSecret: (process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "").trim(),
};
export const GOOGLE_OAUTH_CLIENT = {
  clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
  clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
};

export class OAuthConfigurationError extends Error {
  constructor(providerName, missingVariables) {
    super(
      `${providerName} OAuth is not configured. Missing: ${missingVariables.join(", ")}. ` +
      "Set these variables in the 9Router server environment (.env for local runs or Docker env_file), " +
      "then restart the server or recreate the Docker container."
    );
    this.name = "OAuthConfigurationError";
  }
}

// Validate the complete pair before opening Google, so a missing secret does not
// fail only after the user has already signed in and granted consent.
export function assertOAuthClientConfigured(config, providerName, envPrefix) {
  const missingVariables = [
    ["clientId", `${envPrefix}_CLIENT_ID`],
    ["clientSecret", `${envPrefix}_CLIENT_SECRET`],
  ]
    .filter(([key]) => typeof config[key] !== "string" || !config[key].trim())
    .map(([, variable]) => variable);

  if (missingVariables.length) {
    throw new OAuthConfigurationError(providerName, missingVariables);
  }
}
