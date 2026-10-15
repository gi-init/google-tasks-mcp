import { isAllowedEmail, loadConfig, MCP_SCOPE, type Config } from "@/lib/config";
import { isValidCodeVerifier, s256, safeEqual, seal, unseal } from "@/lib/crypto";
import { refreshGoogleToken } from "@/lib/google/oauth";
import { json, NO_STORE_HEADERS, oauthError, readParams } from "@/lib/http";
import { authenticateClient } from "@/lib/oauth/clients";
import { accessTtl, nowSeconds, REFRESH_TTL } from "@/lib/oauth/lifetimes";
import { settingsMissingError } from "@/lib/oauth/responses";
import { resourceMatches } from "@/lib/oauth/resource";
import type { AccessPayload, CodePayload, RefreshPayload } from "@/lib/types";

/** What a new token pair is made from: who, for which client, and the Google tokens to carry. */
type Grant = Omit<CodePayload, "redirect_uri" | "code_challenge">;

type GoogleTokenSet = Pick<Grant, "g_access" | "g_access_exp" | "g_refresh">;
type GoogleRefresh = { ok: true; google: GoogleTokenSet } | { ok: false; response: Response };

async function refreshAtGoogle(config: Config, gRefresh: string): Promise<GoogleRefresh> {
  const result = await refreshGoogleToken(config, gRefresh);
  if (result.ok) {
    return {
      ok: true,
      google: {
        g_access: result.tokens.access_token,
        g_access_exp: nowSeconds() + result.tokens.expires_in,
        // Google rarely rotates its refresh token, but when it does the new one wins.
        g_refresh: result.tokens.refresh_token ?? gRefresh,
      },
    };
  }
  if (result.error === "invalid_grant") {
    return {
      ok: false,
      response: oauthError("invalid_grant", "Google access was revoked or expired. Connect again."),
    };
  }
  return {
    ok: false,
    response: oauthError("temporarily_unavailable", "Google could not be reached. Try again shortly.", 503),
  };
}

async function issueTokens(config: Config, grant: Grant): Promise<Response> {
  // Google's access tokens last an hour, so this only happens if Google shortens them.
  const ttl = accessTtl(grant.g_access_exp);
  if (ttl <= 0) return oauthError("temporarily_unavailable", "Google returned an access token that expires too soon.", 503);

  const identity = { client_id: grant.client_id, resource: grant.resource, email: grant.email };
  const access: AccessPayload = { ...identity, g_access: grant.g_access };
  const refresh: RefreshPayload = { ...identity, g_refresh: grant.g_refresh };

  return json(
    {
      access_token: await seal("access", access, config.tokenKey, ttl),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: await seal("refresh", refresh, config.tokenKey, REFRESH_TTL),
      scope: MCP_SCOPE,
    },
    200,
    NO_STORE_HEADERS,
  );
}

async function authorizationCodeGrant(
  config: Config,
  clientId: string,
  params: Record<string, string>,
): Promise<Response> {
  const { code, redirect_uri: redirectUri, code_verifier: verifier } = params;
  if (!code || !redirectUri || !verifier) {
    return oauthError("invalid_request", "code, redirect_uri and code_verifier are required.");
  }

  const payload = await unseal<CodePayload>("code", code, config.tokenKey);
  if (!payload) return oauthError("invalid_grant", "The code is invalid or expired.");
  if (payload.client_id !== clientId) return oauthError("invalid_grant", "The code was issued to another client.");
  if (payload.redirect_uri !== redirectUri) return oauthError("invalid_grant", "The redirect_uri does not match.");
  if (!isValidCodeVerifier(verifier) || !safeEqual(s256(verifier), payload.code_challenge)) {
    return oauthError("invalid_grant", "The code_verifier does not match the code_challenge.");
  }
  if (params.resource !== undefined && !resourceMatches(params.resource, payload.resource)) {
    return oauthError("invalid_target", `This code is for ${payload.resource}.`);
  }

  return issueTokens(config, {
    client_id: payload.client_id,
    resource: payload.resource,
    email: payload.email,
    g_refresh: payload.g_refresh,
    g_access: payload.g_access,
    g_access_exp: payload.g_access_exp,
  });
}

async function refreshTokenGrant(config: Config, clientId: string, params: Record<string, string>): Promise<Response> {
  if (!params.refresh_token) return oauthError("invalid_request", "refresh_token is required.");

  const payload = await unseal<RefreshPayload>("refresh", params.refresh_token, config.tokenKey);
  if (!payload) return oauthError("invalid_grant", "The refresh token is invalid or expired.");
  if (payload.client_id !== clientId) return oauthError("invalid_grant", "The refresh token was issued to another client.");
  // Removing someone from ALLOWED_EMAILS cuts them off here, at their next refresh.
  if (!isAllowedEmail(config, payload.email)) {
    return oauthError("invalid_grant", "This Google account is no longer allowed on this server.");
  }
  if (params.resource !== undefined && !resourceMatches(params.resource, payload.resource)) {
    return oauthError("invalid_target", `This refresh token is for ${payload.resource}.`);
  }

  const fresh = await refreshAtGoogle(config, payload.g_refresh);
  if (!fresh.ok) return fresh.response;
  return issueTokens(config, {
    client_id: payload.client_id,
    resource: payload.resource,
    email: payload.email,
    ...fresh.google,
  });
}

/** POST /token: authorization code exchange and refresh. */
export async function handleToken(req: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return settingsMissingError(loaded.missing);
  const { config } = loaded;

  const params = await readParams(req);
  if (!params) return oauthError("invalid_request", "The body must be form-encoded (or JSON) and at most 16 KB.");

  const auth = await authenticateClient(req, params, config.tokenKey);
  if (!auth.ok) return auth.response;

  switch (params.grant_type) {
    case "authorization_code":
      return authorizationCodeGrant(config, auth.clientId, params);
    case "refresh_token":
      return refreshTokenGrant(config, auth.clientId, params);
    default:
      return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }
}
