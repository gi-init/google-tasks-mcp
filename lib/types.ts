/** Payloads inside the sealed blobs from lib/crypto.ts. Lifetimes are in lib/oauth/lifetimes.ts. */

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** Inside a DCR client_id (sealed as "client", no expiry). */
export type DcrClientPayload = {
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
};

/** A client as the authorization endpoint sees it, from DCR or a Client ID Metadata Document. */
export type ResolvedClient = {
  client_id: string;
  kind: "dcr" | "cimd";
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
};

/** The request a person is approving on the consent page (sealed as "consent"). */
export type PendingAuthorization = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  resource: string;
  /** Must match the consent cookie, so a cross-site form post can't skip the page. */
  csrf: string;
};

/** Carried through Google's sign-in as `state` (sealed as "google_state"). */
export type GoogleState = Omit<PendingAuthorization, "csrf"> & {
  /** Must match the nonce cookie set before leaving for Google. */
  nonce: string;
  /** PKCE verifier for the hop to Google. */
  google_verifier: string;
};

/** Inside an authorization code (sealed as "code"). */
export type CodePayload = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  email: string;
  g_refresh: string;
  g_access: string;
  /** When g_access expires, in seconds since the epoch. */
  g_access_exp: number;
};

/** Inside an access token (sealed as "access"). */
export type AccessPayload = {
  client_id: string;
  resource: string;
  email: string;
  g_access: string;
};

/** Inside a refresh token (sealed as "refresh"). */
export type RefreshPayload = {
  client_id: string;
  resource: string;
  email: string;
  g_refresh: string;
};
