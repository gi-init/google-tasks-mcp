import { REPO_URL } from "@/lib/config";
import { hasSpaceOrControl, isValidRedirectUri } from "@/lib/oauth/redirect";
import type { ResolvedClient } from "@/lib/types";

/**
 * Client ID Metadata Documents: a client_id that is an https URL names a JSON
 * document describing the client, which this server fetches when the client
 * starts a sign-in. Because anyone can make the server fetch such a URL, the
 * fetch is kept small: no redirects, a short timeout, a size cap, and no
 * localhost or IP literal hosts.
 */

export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 32 * 1024;
export const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_CACHE_MAX_ENTRIES = 100;
// The client_id is carried inside the consent, state, code and refresh blobs,
// which have to stay under the unseal() length cap.
const MAX_CLIENT_ID_LENGTH = 1024;
// Some hosts refuse requests without a User-Agent; this one says who is asking.
const USER_AGENT = `google-tasks-mcp (+${REPO_URL})`;

export type FetchFn = typeof fetch;

export type CimdResult = { ok: true; client: ResolvedClient } | { ok: false; reason: string };

/** Any https client_id is a CIMD client_id; cimdClientIdProblem says whether it is an acceptable one. */
export function isCimdClientId(clientId: string): boolean {
  return /^https:/i.test(clientId);
}

/** Why this client_id can't be a metadata document URL, or null when it can. */
export function cimdClientIdProblem(clientId: string): string | null {
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return "The client_id URL is too long.";
  if (hasSpaceOrControl(clientId) || !URL.canParse(clientId)) return "The client_id is not a valid URL.";
  const url = new URL(clientId);
  if (url.protocol !== "https:") return "The client_id URL must use https.";
  if (clientId.includes("#")) return "The client_id URL must not have a fragment.";
  // A query could nest another client_id, so one request could make this
  // server fetch its own /authorize again and again.
  if (clientId.includes("?")) return "The client_id URL must not have a query.";
  if (url.username || url.password) return "The client_id URL must not contain a user name or password.";
  if (url.pathname === "/" || url.pathname === "") return "The client_id URL must have a path.";
  if (/\/(\.|%2e){1,2}(\/|\?|$)/i.test(clientId)) return "The client_id URL must not contain . or .. segments.";
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return "The client_id URL must not point at localhost.";
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return "The client_id URL must use a host name, not an IP address.";
  // A one-label name such as https://intranet/ can only reach a private network.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return "The client_id URL must use a public host name.";
  return null;
}

type CacheEntry = { client: ResolvedClient; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function clearCimdCache(): void {
  cache.clear();
}

function remember(client: ResolvedClient): void {
  if (cache.size >= CIMD_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(client.client_id, { client, expiresAt: Date.now() + CIMD_CACHE_TTL_MS });
}

function isJsonType(contentType: string | null): boolean {
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType);
}

/** Reads the body, giving up as soon as it passes maxBytes. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function parseDocument(clientId: string, body: string): CimdResult {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ok: false, reason: "The client metadata document is not valid JSON." };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, reason: "The client metadata document is not a JSON object." };
  }
  const meta = doc as Record<string, unknown>;
  if (meta.client_id !== clientId) {
    return { ok: false, reason: "The client metadata document's client_id does not match its URL." };
  }
  const redirectUris = meta.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
    return { ok: false, reason: "The client metadata document has missing or invalid redirect_uris." };
  }
  if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== "none") {
    return { ok: false, reason: "A client metadata document must use token_endpoint_auth_method none." };
  }
  return {
    ok: true,
    client: {
      client_id: clientId,
      kind: "cimd",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    },
  };
}

/** Fetches, checks and caches the metadata document a CIMD client_id points to. */
export async function loadClientMetadata(clientId: string, fetchFn: FetchFn = fetch): Promise<CimdResult> {
  const problem = cimdClientIdProblem(clientId);
  if (problem) return { ok: false, reason: problem };

  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, client: cached.client };
  if (cached) cache.delete(clientId);

  let body: string | null;
  try {
    const response = await fetchFn(clientId, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return { ok: false, reason: `The client metadata document answered with status ${response.status}.` };
    }
    if (!isJsonType(response.headers.get("content-type"))) {
      return { ok: false, reason: "The client metadata document is not served as JSON." };
    }
    body = await readCapped(response, CIMD_MAX_BYTES);
  } catch {
    return { ok: false, reason: "The client metadata document could not be fetched." };
  }
  if (body === null) return { ok: false, reason: "The client metadata document is larger than 32 KB." };

  const result = parseDocument(clientId, body);
  if (result.ok) remember(result.client);
  return result;
}
