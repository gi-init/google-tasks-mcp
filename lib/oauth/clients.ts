import { clientSecretFor, safeEqual, unseal } from "@/lib/crypto";
import { oauthError } from "@/lib/http";
import { cimdClientIdProblem, isCimdClientId, loadClientMetadata } from "@/lib/oauth/cimd";
import { isValidRedirectUri } from "@/lib/oauth/redirect";
import type { DcrClientPayload, ResolvedClient, TokenEndpointAuthMethod } from "@/lib/types";

export const AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

export type ClientLookup = { ok: true; client: ResolvedClient } | { ok: false; reason: string };

/** Opens a DCR client_id. Null when it is forged, from another key, or not a client blob. */
export async function openDcrClient(clientId: string, key: Uint8Array): Promise<ResolvedClient | null> {
  const payload = await unseal<DcrClientPayload>("client", clientId, key);
  if (!payload) return null;
  const { redirect_uris, token_endpoint_auth_method } = payload;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every(isValidRedirectUri)) return null;
  if (!AUTH_METHODS.includes(token_endpoint_auth_method)) return null;
  return {
    client_id: clientId,
    kind: "dcr",
    redirect_uris,
    token_endpoint_auth_method,
  };
}

/** The client behind a client_id at the authorization endpoint: a metadata document URL or a DCR blob. */
export async function resolveClient(clientId: string | null | undefined, key: Uint8Array): Promise<ClientLookup> {
  if (!clientId) return { ok: false, reason: "The request has no client_id." };
  if (isCimdClientId(clientId)) return loadClientMetadata(clientId);
  const client = await openDcrClient(clientId, key);
  if (!client) return { ok: false, reason: "The client_id was not issued by this server." };
  return { ok: true, client };
}

export type ClientAuthentication = { ok: true; clientId: string } | { ok: false; response: Response };

function invalidClient(description: string, usedBasic: boolean): ClientAuthentication {
  // RFC 6749 section 5.2: a failed Basic login gets a matching challenge.
  const headers: Record<string, string> = usedBasic ? { "WWW-Authenticate": 'Basic realm="token"' } : {};
  return { ok: false, response: oauthError("invalid_client", description, 401, headers) };
}

/** RFC 6749 section 2.3.1: both halves are form-encoded before base64. */
function parseBasic(header: string): { id: string; secret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  // Split at the last colon: the client_id can be a URL, and secrets this server issues have no colon.
  const index = decoded.lastIndexOf(":");
  if (index === -1) return null;
  try {
    const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, "%20"));
    return { id: decode(decoded.slice(0, index)), secret: decode(decoded.slice(index + 1)) };
  } catch {
    return null;
  }
}

/**
 * Token endpoint client authentication: HTTP Basic or client_id/client_secret
 * in the body. A metadata document client is public. A DCR client must open,
 * and a confidential one must present its derived secret by either method.
 */
export async function authenticateClient(
  req: Request,
  params: Record<string, string>,
  key: Uint8Array,
): Promise<ClientAuthentication> {
  let clientId = params.client_id;
  let secret = params.client_secret;
  let usedBasic = false;

  const header = req.headers.get("authorization");
  if (header && /^Basic\s/i.test(header)) {
    usedBasic = true;
    const basic = parseBasic(header);
    if (!basic) return invalidClient("The Authorization header is not valid HTTP Basic.", true);
    // Some clients repeat their credentials in the body. Tolerate that, but never a disagreement.
    if (params.client_id !== undefined && params.client_id !== basic.id) {
      return invalidClient("The client_id in the body does not match the Authorization header.", true);
    }
    if (params.client_secret !== undefined && params.client_secret !== basic.secret) {
      return invalidClient("The client_secret in the body does not match the Authorization header.", true);
    }
    clientId = basic.id;
    secret = basic.secret;
  }

  if (!clientId) return invalidClient("client_id is required.", usedBasic);

  if (isCimdClientId(clientId)) {
    if (cimdClientIdProblem(clientId)) return invalidClient("The client_id is not a usable metadata document URL.", usedBasic);
    return { ok: true, clientId };
  }

  const client = await openDcrClient(clientId, key);
  if (!client) return invalidClient("The client_id was not issued by this server.", usedBasic);
  if (client.token_endpoint_auth_method !== "none") {
    if (!secret || !safeEqual(secret, clientSecretFor(clientId, key))) {
      return invalidClient("The client secret is missing or wrong.", usedBasic);
    }
  }
  return { ok: true, clientId };
}
