import { GOOGLE_TASKS_SCOPE, type Config } from "@/lib/config";

/** Google's side of the sign-in: the consent URL, code exchange, refresh, revoke and the ID token. */

export const GOOGLE_SCOPES = ["openid", "email", GOOGLE_TASKS_SCOPE].join(" ");
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const GOOGLE_TIMEOUT_MS = 10_000;
// Google access tokens last an hour; this is only used if a response leaves expires_in out.
const DEFAULT_EXPIRES_IN = 3599;

export type GoogleTokens = {
  access_token: string;
  /** Seconds until access_token expires. */
  expires_in: number;
  refresh_token?: string;
  /** Space-separated scopes the person actually granted. */
  scope?: string;
  id_token?: string;
};

export type GoogleTokenResult =
  | { ok: true; tokens: GoogleTokens }
  /** `error` is Google's error code, or network_error / invalid_response. */
  | { ok: false; error: string };

export type GoogleAuthParams = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
};

export function googleAuthorizationUrl(config: Config, params: GoogleAuthParams): string {
  const url = new URL(config.googleAuthUrl);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  // Without offline access Google issues no refresh token, and access would end after an hour.
  url.searchParams.set("access_type", "offline");
  // Google only sends a refresh token on a fresh consent, so always ask.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

async function postToTokenEndpoint(config: Config, body: Record<string, string>): Promise<GoogleTokenResult> {
  let response: Response;
  try {
    response = await fetch(config.googleTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = typeof data?.error === "string" ? data.error : "invalid_response";
    return { ok: false, error };
  }
  if (!data || typeof data.access_token !== "string" || data.access_token.length === 0) {
    return { ok: false, error: "invalid_response" };
  }

  const expiresIn = Number(data.expires_in);
  return {
    ok: true,
    tokens: {
      access_token: data.access_token,
      expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN,
      refresh_token: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : undefined,
      scope: typeof data.scope === "string" ? data.scope : undefined,
      id_token: typeof data.id_token === "string" ? data.id_token : undefined,
    },
  };
}

export function exchangeGoogleCode(
  config: Config,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GoogleTokenResult> {
  return postToTokenEndpoint(config, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
  });
}

export function refreshGoogleToken(config: Config, refreshToken: string): Promise<GoogleTokenResult> {
  return postToTokenEndpoint(config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
  });
}

/** Best effort. Revoking either token ends the whole grant. */
export async function revokeGoogleToken(config: Config, token: string): Promise<void> {
  try {
    await fetch(config.googleRevokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    // Nothing more to do. The caller refuses the sign-in either way.
  }
}

/**
 * The claims inside an ID token, without checking its signature. Only for an
 * ID token that came straight from Google's token endpoint over TLS.
 */
export function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function grantedScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((value) => value.length > 0);
}
