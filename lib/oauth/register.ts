import { loadConfig } from "@/lib/config";
import { clientSecretFor, seal } from "@/lib/crypto";
import { json, NO_STORE_HEADERS, oauthError } from "@/lib/http";
import { AUTH_METHODS } from "@/lib/oauth/clients";
import { cleanClientName } from "@/lib/oauth/names";
import { isValidRedirectUri } from "@/lib/oauth/redirect";
import { settingsMissingError } from "@/lib/oauth/responses";
import type { DcrClientPayload, TokenEndpointAuthMethod } from "@/lib/types";

const MAX_BODY_BYTES = 16_384;
const MAX_REDIRECT_URIS = 10;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES = ["code"];
// The client_id rides inside the consent, state, code and refresh blobs, which
// unseal() caps at 8192 characters, so the client_id itself has to stay small.
const MAX_CLIENT_ID_LENGTH = 2048;

function invalidMetadata(description: string): Response {
  return oauthError("invalid_client_metadata", description);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** An optional list that must be a subset of `allowed`. Missing, null or empty means the default. */
function subsetOf(value: unknown, allowed: string[], name: string): { ok: true; value: string[] } | { ok: false; response: Response } {
  if (value === undefined || value === null) return { ok: true, value: allowed };
  if (!isStringArray(value)) return { ok: false, response: invalidMetadata(`${name} must be an array of strings.`) };
  if (!value.every((item) => allowed.includes(item))) {
    return { ok: false, response: invalidMetadata(`${name} may only contain ${allowed.join(", ")}.`) };
  }
  return { ok: true, value: value.length > 0 ? [...new Set(value)] : allowed };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null | "too_large"> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too_large";
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return "too_large";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** POST /register: RFC 7591 Dynamic Client Registration. The client_id is the sealed registration itself. */
export async function handleRegister(req: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return settingsMissingError(loaded.missing);
  const { config } = loaded;

  const body = await readJsonBody(req);
  if (body === "too_large") return invalidMetadata("The registration must be at most 16 KB.");
  if (!body) return invalidMetadata("The registration must be a JSON object.");

  const redirectUris = body.redirect_uris;
  if (
    !isStringArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(isValidRedirectUri)
  ) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must list 1 to 10 URIs: https, http on localhost, 127.0.0.1 or [::1], or an app's own scheme, with no fragment.",
    );
  }

  const method = body.token_endpoint_auth_method ?? "client_secret_basic";
  if (typeof method !== "string" || !AUTH_METHODS.includes(method as TokenEndpointAuthMethod)) {
    return invalidMetadata("token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.");
  }
  const authMethod = method as TokenEndpointAuthMethod;

  const grantTypes = subsetOf(body.grant_types, GRANT_TYPES, "grant_types");
  if (!grantTypes.ok) return grantTypes.response;
  const responseTypes = subsetOf(body.response_types, RESPONSE_TYPES, "response_types");
  if (!responseTypes.ok) return responseTypes.response;

  if (body.client_name !== undefined && body.client_name !== null && typeof body.client_name !== "string") {
    return invalidMetadata("client_name must be a string.");
  }
  const clientName = cleanClientName(body.client_name);

  const payload: DcrClientPayload = {
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
  };
  const clientId = await seal("client", payload, config.tokenKey);
  if (clientId.length > MAX_CLIENT_ID_LENGTH) {
    return invalidMetadata("The registration is too large. Register fewer or shorter redirect_uris.");
  }

  const confidential = authMethod !== "none";
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes.value,
      response_types: responseTypes.value,
      token_endpoint_auth_method: authMethod,
      ...(confidential ? { client_secret: clientSecretFor(clientId, config.tokenKey), client_secret_expires_at: 0 } : {}),
    },
    201,
    NO_STORE_HEADERS,
  );
}
