import type { AuthInfo } from "@modelcontextprotocol/server";
import { isAllowedEmail, loadConfig, MCP_SCOPE, publicOrigin, resourceUrl } from "@/lib/config";
import { unseal } from "@/lib/crypto";
import type { AccessPayload } from "@/lib/types";

/**
 * The verifier withMcpAuth calls on every /mcp request. An access token is a
 * sealed "access" blob minted by /token; anything else, or one minted for
 * another resource, gets undefined and so a 401 challenge.
 */
export async function verifyAccessToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const loaded = loadConfig();
  if (!loaded.ok) return undefined;
  const { config } = loaded;

  const payload = await unseal<AccessPayload>("access", bearerToken, config.tokenKey);
  if (!payload || typeof payload.exp !== "number") return undefined;
  if (typeof payload.g_access !== "string" || payload.g_access.length === 0) return undefined;

  const expected = resourceUrl(publicOrigin(req));
  if (payload.resource !== expected) return undefined;

  // Checked here as well as at refresh, so removing an email takes effect at once.
  if (typeof payload.email !== "string" || !isAllowedEmail(config, payload.email)) return undefined;

  return {
    token: bearerToken,
    clientId: payload.client_id,
    scopes: [MCP_SCOPE],
    expiresAt: payload.exp,
    resource: new URL(expected),
    extra: { googleAccessToken: payload.g_access, email: payload.email },
  };
}
