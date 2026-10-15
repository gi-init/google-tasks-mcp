/** Redirect URI rules: docs/design.md, "Redirect URIs". */

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const MAX_REDIRECT_URI_LENGTH = 2048;

// After URL parsing a domain is lowercased and punycoded, so anything outside
// this set is not a real host name. Keeping hosts this plain also keeps them
// safe to show on the consent page and to put in a CSP header.
const DNS_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/** True when the string has whitespace or control characters anywhere. */
export function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/.test(value);
}

function parse(uri: unknown): URL | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return null;
  // The URL parser silently drops tabs, newlines and edge whitespace, which
  // would let two different strings name the same place.
  if (hasSpaceOrControl(uri)) return null;
  if (uri.includes("#")) return null;
  if (!URL.canParse(uri)) return null;
  const url = new URL(uri);
  if (url.username || url.password) return null;
  return url;
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function isValidRedirectUri(uri: unknown): uri is string {
  const url = parse(uri);
  if (!url) return false;
  if (url.protocol === "https:") return DNS_HOSTNAME.test(url.hostname) || IPV6_LITERAL.test(url.hostname);
  if (url.protocol === "http:") return isLoopbackHttp(url);
  return !BLOCKED_SCHEMES.has(url.protocol);
}

/**
 * Exact match, or for a registered loopback http URL the same scheme, host,
 * path and query on any port (RFC 8252 section 7.3).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return isValidRedirectUri(requested);
  const reg = parse(registered);
  const req = parse(requested);
  if (!reg || !req || !isLoopbackHttp(reg)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/** The redirect URI to use for this request, or null when it isn't one the client registered. */
export function resolveRedirectUri(registered: string[], requested: string | undefined): string | null {
  if (!requested) return registered.length === 1 ? registered[0] : null;
  return registered.some((uri) => redirectUriMatches(uri, requested)) ? requested : null;
}

/** What the consent page shows as the destination, e.g. "claude.ai" or "com.example.app". */
export function redirectDisplayHost(uri: string): string {
  const url = new URL(uri);
  return url.host || url.protocol.slice(0, -1);
}

/**
 * A CSP form-action source that allows a redirect to this URI. Private-use
 * schemes and hosts CSP can't express (IPv6 literals) fall back to the scheme.
 */
export function formActionSource(uri: string): string {
  const url = new URL(uri);
  if ((url.protocol === "https:" || url.protocol === "http:") && DNS_HOSTNAME.test(url.hostname)) {
    return url.origin;
  }
  return url.protocol;
}

/** Adds authorization response parameters to a client's redirect URI, keeping its own query as written. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  const extra = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) extra.set(key, value);
  }
  const query = extra.toString();
  url.search = url.search.length > 1 ? `${url.search.slice(1)}&${query}` : query;
  return url.toString();
}
