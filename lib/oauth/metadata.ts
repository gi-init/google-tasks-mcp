import { MCP_SCOPE, REPO_URL, resourceUrl } from "@/lib/config";

/** RFC 9728 protected resource metadata for the /mcp endpoint. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Google Tasks",
    resource_documentation: REPO_URL,
  };
}

/**
 * RFC 8414 authorization server metadata. Claude uses a Client ID Metadata
 * Document only when both client_id_metadata_document_supported and the "none"
 * auth method are listed, and asks for offline_access because it is listed.
 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [MCP_SCOPE, "offline_access"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: REPO_URL,
  };
}
