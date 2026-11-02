// Supply Google OAuth app credentials at runtime; never publish them in this fork.
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "",
  clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "",
};
export const GOOGLE_OAUTH_CLIENT = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
};
