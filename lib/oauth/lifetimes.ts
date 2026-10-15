/** How long each sealed blob lives, in seconds. docs/design.md, "Lifetimes". */

export const CONSENT_TTL = 10 * 60;
export const GOOGLE_STATE_TTL = 10 * 60;
export const CODE_TTL = 2 * 60;
export const REFRESH_TTL = 180 * 24 * 60 * 60;

export const ACCESS_MAX_TTL = 60 * 60;
/** An access token dies this long before the Google token inside it, so a call never carries a dead one. */
export const ACCESS_EXPIRY_MARGIN = 60;

/** The csrf and nonce cookies live as long as the blobs they guard. */
export const FLOW_COOKIE_MAX_AGE = 10 * 60;

/**
 * unseal() refuses anything longer than this, so every blob this server hands
 * out has to stay under it, including blobs that nest a DCR client_id.
 */
export const SEALED_MAX_LENGTH = 8192;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Lifetime of an access token wrapping a Google access token that expires at `googleExpiresAt`. */
export function accessTtl(googleExpiresAt: number, now = nowSeconds()): number {
  return Math.min(ACCESS_MAX_TTL, googleExpiresAt - now - ACCESS_EXPIRY_MARGIN);
}
