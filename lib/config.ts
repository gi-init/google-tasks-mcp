import { hkdfSync } from "node:crypto";
import { getPublicOrigin } from "mcp-handler";

/** The Google scope the server asks for. Read-only access to Google Tasks. */
export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";

/** The one scope this server grants to MCP clients. */
export const MCP_SCOPE = "tasks";

export const REPO_URL = "https://github.com/pdcarlson/google-tasks-mcp";

export type Config = {
  googleClientId: string;
  googleClientSecret: string;
  /** Lowercased Google account emails that may sign in. */
  allowedEmails: string[];
  /** 32-byte key that seals every code, token and client id this server issues. */
  tokenKey: Uint8Array;
  googleAuthUrl: string;
  googleTokenUrl: string;
  googleRevokeUrl: string;
  tasksApiUrl: string;
};

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; missing: string[] };

/**
 * Reads settings from the environment. Only the three settings a person has to
 * provide count as missing. The Google endpoint overrides let you run the
 * server against a stand-in Google for local end-to-end testing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const allowedEmails = parseEmails(env.ALLOWED_EMAILS);

  const missing: string[] = [];
  if (!googleClientId) missing.push("GOOGLE_CLIENT_ID");
  if (!googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (allowedEmails.length === 0) missing.push("ALLOWED_EMAILS");
  if (missing.length > 0) return { ok: false, missing };

  // The key comes from TOKEN_SECRET when set, and otherwise from the Google
  // client secret, so a deployment has one less secret to make. Rotating
  // either one signs everyone out.
  const secret = env.TOKEN_SECRET?.trim() || googleClientSecret;

  return {
    ok: true,
    config: {
      googleClientId,
      googleClientSecret,
      allowedEmails,
      tokenKey: deriveKey(secret),
      googleAuthUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
      googleTokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
      googleRevokeUrl: env.GOOGLE_REVOKE_URL || "https://oauth2.googleapis.com/revoke",
      tasksApiUrl: (env.GOOGLE_TASKS_API_URL || "https://tasks.googleapis.com/tasks/v1").replace(/\/+$/, ""),
    },
  };
}

export function parseEmails(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function isAllowedEmail(config: Config, email: string): boolean {
  return config.allowedEmails.includes(email.trim().toLowerCase());
}

export function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, "google-tasks-mcp", "token key v1", 32));
}

/**
 * The public origin the request came in on, such as https://tasks.example.com.
 * PUBLIC_URL wins when set; otherwise Vercel's forwarding headers decide.
 */
export function publicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.PUBLIC_URL?.trim();
  if (fixed) return new URL(fixed).origin;
  return getPublicOrigin(req);
}

/** The MCP endpoint's URL, which is also its OAuth resource identifier. */
export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function googleCallbackUrl(origin: string): string {
  return `${origin}/oauth/google/callback`;
}
