import { afterEach, describe, expect, it } from "vitest";
import * as authorizationServer from "@/app/.well-known/oauth-authorization-server/route";
import * as protectedResource from "@/app/.well-known/oauth-protected-resource/route";
import * as protectedResourceMcp from "@/app/.well-known/oauth-protected-resource/mcp/route";

const ORIGIN = "https://tasks.example.com";

const expectedProtectedResource = {
  resource: `${ORIGIN}/mcp`,
  authorization_servers: [ORIGIN],
  scopes_supported: ["tasks"],
  bearer_methods_supported: ["header"],
  resource_name: "Google Tasks",
  resource_documentation: "https://github.com/pdcarlson/google-tasks-mcp",
};

const expectedAuthorizationServer = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/authorize`,
  token_endpoint: `${ORIGIN}/token`,
  registration_endpoint: `${ORIGIN}/register`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  scopes_supported: ["tasks", "offline_access"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  service_documentation: "https://github.com/pdcarlson/google-tasks-mcp",
};

const savedPublicUrl = process.env.PUBLIC_URL;

afterEach(() => {
  process.env.PUBLIC_URL = savedPublicUrl;
});

describe("protected resource metadata", () => {
  it.each([
    ["/.well-known/oauth-protected-resource", protectedResource],
    ["/.well-known/oauth-protected-resource/mcp", protectedResourceMcp],
  ])("serves %s", async (path, route) => {
    const res = route.GET(new Request(`${ORIGIN}${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual(expectedProtectedResource);
  });

  it("answers preflights", () => {
    for (const route of [protectedResource, protectedResourceMcp]) {
      const res = route.OPTIONS();
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
    }
  });
});

describe("authorization server metadata", () => {
  it("serves the RFC 8414 document", async () => {
    const res = authorizationServer.GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual(expectedAuthorizationServer);
  });

  it("lists what Claude needs to pick a Client ID Metadata Document", async () => {
    const body = await authorizationServer.GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
    expect(body.scopes_supported).toContain("offline_access");
  });

  it("answers preflights", () => {
    expect(authorizationServer.OPTIONS().status).toBe(204);
  });
});

describe("without PUBLIC_URL", () => {
  it("uses the forwarded host", async () => {
    delete process.env.PUBLIC_URL;
    const req = new Request("http://internal:3000/.well-known/oauth-authorization-server", {
      headers: { "x-forwarded-host": "tasks.other.example", "x-forwarded-proto": "https" },
    });
    const body = await authorizationServer.GET(req).json();
    expect(body.issuer).toBe("https://tasks.other.example");
    expect(body.token_endpoint).toBe("https://tasks.other.example/token");
    const resource = await protectedResourceMcp.GET(req).json();
    expect(resource.resource).toBe("https://tasks.other.example/mcp");
    expect(resource.authorization_servers).toEqual(["https://tasks.other.example"]);
  });
});
