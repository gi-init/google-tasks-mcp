import { googleCallbackUrl, loadConfig, publicOrigin, resourceUrl } from "@/lib/config";
import { isValidCodeChallenge, randomString, s256, safeEqual, seal, unseal } from "@/lib/crypto";
import { googleAuthorizationUrl } from "@/lib/google/oauth";
import { clearCookie, readCookie, readParams, setCookie } from "@/lib/http";
import { resolveClient } from "@/lib/oauth/clients";
import { CONSENT_TTL, FLOW_COOKIE_MAX_AGE, GOOGLE_STATE_TTL, SEALED_MAX_LENGTH } from "@/lib/oauth/lifetimes";
import { formActionSource, redirectDisplayHost, resolveRedirectUri, withParams } from "@/lib/oauth/redirect";
import {
  CSRF_COOKIE,
  errorPageResponse,
  NONCE_COOKIE,
  redirectResponse,
  settingsMissingPage,
} from "@/lib/oauth/responses";
import { isOurResource } from "@/lib/oauth/resource";
import type { GoogleState, PendingAuthorization } from "@/lib/types";
import { consentPage, htmlResponse } from "@/lib/ui";

// The google_state blob is the consent blob plus a nonce and a verifier, less
// the csrf value. Leaving this much room means it still opens later.
const GOOGLE_STATE_HEADROOM = 256;

/** GET /authorize: check the request, then show the consent page. */
export async function handleAuthorizeGet(req: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return settingsMissingPage(loaded.missing);
  const { config } = loaded;
  const origin = publicOrigin(req);
  const params = new URL(req.url).searchParams;

  // Errors here show a page and never redirect. Anyone can register any
  // redirect URI, so sending errors there would make this an open redirect.
  const fail = (description: string) => errorPageResponse(400, "This sign-in can't continue", description);

  const lookup = await resolveClient(params.get("client_id"), config.tokenKey);
  if (!lookup.ok) return errorPageResponse(400, "This app isn't recognized", `${lookup.reason}`);
  const client = lookup.client;

  const redirectUri = resolveRedirectUri(client.redirect_uris, params.get("redirect_uri") || undefined);
  if (!redirectUri) return fail("The redirect_uri is missing or isn't one this app registered.");

  if (params.get("response_type") !== "code") return fail("Only response_type=code is supported.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!isValidCodeChallenge(codeChallenge) || params.get("code_challenge_method") !== "S256") {
    return fail("PKCE is required. Send a code_challenge with code_challenge_method=S256.");
  }
  if (!params.getAll("resource").every((resource) => isOurResource(resource, origin))) {
    return fail(`The only resource this server issues tokens for is ${resourceUrl(origin)}.`);
  }

  const csrf = randomString();
  const pending: PendingAuthorization = {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: params.get("state") ?? undefined,
    resource: resourceUrl(origin),
    csrf,
  };
  const request = await seal("consent", pending, config.tokenKey, CONSENT_TTL);
  if (request.length > SEALED_MAX_LENGTH - GOOGLE_STATE_HEADROOM) {
    return fail("The authorization request is too large. Use a shorter state or redirect_uri.");
  }

  // The app is named by a host it can't fake, never by its self-chosen
  // client_name. For a metadata document that is the host it is served from,
  // and for a registered client the host the code goes back to.
  const redirectHost = redirectDisplayHost(redirectUri);
  const clientName = client.kind === "cimd" ? new URL(client.client_id).host : redirectHost;
  return htmlResponse(
    consentPage({ clientName, redirectHost, request, action: "/authorize" }),
    {
      headers: { "Set-Cookie": setCookie(CSRF_COOKIE, csrf, { maxAge: FLOW_COOKIE_MAX_AGE, sameSite: "Strict" }) },
      // The form posts here, and the answer redirects to Google (allow) or back
      // to the client (deny). Chrome checks form-action against redirects too.
      formActionOrigins: [new URL(config.googleAuthUrl).origin, formActionSource(redirectUri)],
    },
  );
}

/** POST /authorize: the consent form. Sends the person on to Google, or back to the client on deny. */
export async function handleAuthorizePost(req: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return settingsMissingPage(loaded.missing);
  const { config } = loaded;
  const origin = publicOrigin(req);

  const params = await readParams(req);
  const pending = await unseal<PendingAuthorization>("consent", params?.request, config.tokenKey);
  if (!params || !pending) {
    return errorPageResponse(400, "This sign-in has expired", `The sign-in page was open too long or was changed.`);
  }

  const csrf = readCookie(req, CSRF_COOKIE);
  if (!csrf || !safeEqual(csrf, pending.csrf)) {
    return errorPageResponse(
      403,
      "This sign-in can't be confirmed",
      `The approval didn't come from the page this server showed. Your browser may be blocking cookies, or another sign-in was started in a different tab.`,
    );
  }

  if (params.decision === "deny") {
    const location = withParams(pending.redirect_uri, {
      error: "access_denied",
      error_description: "The request was declined.",
      state: pending.state,
      iss: origin,
    });
    return redirectResponse(location, 303, [clearCookie(CSRF_COOKIE)]);
  }

  const nonce = randomString();
  const googleVerifier = randomString();
  const googleState: GoogleState = {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    state: pending.state,
    resource: pending.resource,
    nonce,
    google_verifier: googleVerifier,
  };
  const sealedState = await seal("google_state", googleState, config.tokenKey, GOOGLE_STATE_TTL);
  const location = googleAuthorizationUrl(config, {
    redirectUri: googleCallbackUrl(origin),
    state: sealedState,
    codeChallenge: s256(googleVerifier),
    loginHint: config.allowedEmails.length === 1 ? config.allowedEmails[0] : undefined,
  });
  return redirectResponse(location, 303, [
    // Lax, not Strict: Google's redirect back here is a cross-site navigation.
    setCookie(NONCE_COOKIE, nonce, { maxAge: FLOW_COOKIE_MAX_AGE, sameSite: "Lax" }),
    clearCookie(CSRF_COOKIE),
  ]);
}
