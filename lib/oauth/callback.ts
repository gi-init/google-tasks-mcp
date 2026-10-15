import { googleCallbackUrl, GOOGLE_TASKS_SCOPE, isAllowedEmail, loadConfig, publicOrigin, type Config } from "@/lib/config";
import { safeEqual, seal, unseal } from "@/lib/crypto";
import {
  decodeIdTokenPayload,
  exchangeGoogleCode,
  GOOGLE_ISSUERS,
  grantedScopes,
  revokeGoogleToken,
  type GoogleTokens,
} from "@/lib/google/oauth";
import { clearCookie, readCookie } from "@/lib/http";
import { CODE_TTL, nowSeconds, SEALED_MAX_LENGTH } from "@/lib/oauth/lifetimes";
import { withParams } from "@/lib/oauth/redirect";
import {
  errorPageResponse,
  NONCE_COOKIE,
  redirectResponse,
  settingsMissingPage,
} from "@/lib/oauth/responses";
import type { CodePayload, GoogleState } from "@/lib/types";

type Identity = { ok: true; email: string } | { ok: false; email?: string };

/**
 * Who signed in, from the ID token's claims. Its signature isn't checked: it
 * came straight from Google's token endpoint over TLS, in answer to our own
 * authenticated request.
 */
function readIdentity(config: Config, tokens: GoogleTokens): Identity {
  const claims = tokens.id_token ? decodeIdTokenPayload(tokens.id_token) : null;
  if (!claims) return { ok: false };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
  const aud = claims.aud;
  const audienceOk = aud === config.googleClientId || (Array.isArray(aud) && aud.includes(config.googleClientId));
  const issuerOk = typeof claims.iss === "string" && GOOGLE_ISSUERS.includes(claims.iss);
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!audienceOk || !issuerOk || !verified || !email || !isAllowedEmail(config, email)) {
    return { ok: false, email };
  }
  return { ok: true, email };
}

/** GET /oauth/google/callback: Google sends the person back here. */
export async function handleGoogleCallback(req: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return settingsMissingPage(loaded.missing);
  const { config } = loaded;
  const origin = publicOrigin(req);
  const params = new URL(req.url).searchParams;

  const googleState = await unseal<GoogleState>("google_state", params.get("state"), config.tokenKey);
  if (!googleState) {
    return errorPageResponse(400, "This sign-in has expired", `The sign-in took too long or the link was changed.`);
  }

  const nonce = readCookie(req, NONCE_COOKIE);
  if (!nonce || !safeEqual(nonce, googleState.nonce)) {
    return errorPageResponse(
      403,
      "This sign-in can't be confirmed",
      `It didn't start in this browser, or another sign-in was started since.`,
    );
  }

  // The nonce has done its job; every answer from here on clears it.
  const clearNonce = clearCookie(NONCE_COOKIE);
  const toClient = (values: Record<string, string>) =>
    redirectResponse(
      withParams(googleState.redirect_uri, { ...values, state: googleState.state, iss: origin }),
      302,
      [clearNonce],
    );

  if (params.get("error")) {
    return toClient({ error: "access_denied", error_description: "Google sign-in was cancelled or refused." });
  }

  const googleCode = params.get("code");
  if (!googleCode) {
    return errorPageResponse(400, "Google sign-in didn't finish", `Google sent no sign-in code.`, clearNonce);
  }

  const exchanged = await exchangeGoogleCode(config, {
    code: googleCode,
    codeVerifier: googleState.google_verifier,
    redirectUri: googleCallbackUrl(origin),
  });
  if (!exchanged.ok) {
    return errorPageResponse(
      502,
      "Google sign-in failed",
      `Google didn't accept the sign-in (${exchanged.error}).`,
      clearNonce,
    );
  }
  const tokens = exchanged.tokens;

  const identity = readIdentity(config, tokens);
  if (!identity.ok) {
    // Best effort, so a refused account doesn't keep a grant it can't use.
    await revokeGoogleToken(config, tokens.refresh_token ?? tokens.access_token);
    const who = identity.email ? `You signed in to Google as ${identity.email}.` : "Google didn't confirm which account signed in.";
    return errorPageResponse(
      403,
      "This Google account isn't allowed",
      `${who} Only the accounts listed in this server's ALLOWED_EMAILS setting, with a verified email, can connect.`,
      clearNonce,
    );
  }

  if (!grantedScopes(tokens.scope).includes(GOOGLE_TASKS_SCOPE)) {
    return errorPageResponse(
      400,
      "Google Tasks access wasn't granted",
      `On Google's consent screen, tick the box that allows access to Google Tasks.`,
      clearNonce,
    );
  }
  if (!tokens.refresh_token) {
    return errorPageResponse(
      502,
      "Google didn't send a refresh token",
      `Without one, access would end after an hour.`,
      clearNonce,
    );
  }

  const code: CodePayload = {
    client_id: googleState.client_id,
    redirect_uri: googleState.redirect_uri,
    code_challenge: googleState.code_challenge,
    resource: googleState.resource,
    email: identity.email,
    g_refresh: tokens.refresh_token,
    g_access: tokens.access_token,
    g_access_exp: nowSeconds() + tokens.expires_in,
  };
  const sealed = await seal("code", code, config.tokenKey, CODE_TTL);
  if (sealed.length > SEALED_MAX_LENGTH) {
    // Only possible with very long client ids, redirect URIs and Google tokens
    // together. Failing here beats handing out a code /token can never open.
    return errorPageResponse(
      502,
      "This sign-in can't finish",
      `The sign-in details are too large to pass back to the app.`,
      clearNonce,
    );
  }
  return toClient({ code: sealed });
}
