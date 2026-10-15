import { afterEach, describe, expect, it } from "vitest";
import { OPTIONS, POST } from "@/app/register/route";
import { loadConfig } from "@/lib/config";
import { clientSecretFor, unseal } from "@/lib/crypto";
import { resolveClient } from "@/lib/oauth/clients";
import type { DcrClientPayload } from "@/lib/types";

const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function key(): Uint8Array {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error("test settings are missing");
  return loaded.config.tokenKey;
}

function register(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("https://tasks.example.com/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function expectError(res: Response, error: string) {
  expect(res.status).toBe(400);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body.error).toBe(error);
  expect(typeof body.error_description).toBe("string");
}

const savedAllowed = process.env.ALLOWED_EMAILS;

afterEach(() => {
  process.env.ALLOWED_EMAILS = savedAllowed;
});

describe("POST /register", () => {
  it("registers a public client", async () => {
    const res = await register({
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: "none",
      client_name: "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toEqual({
      client_id: expect.any(String),
      client_id_issued_at: expect.any(Number),
      client_name: "Claude",
      redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(Math.abs(body.client_id_issued_at - Date.now() / 1000)).toBeLessThan(5);

    const payload = await unseal<DcrClientPayload>("client", body.client_id, key());
    expect(payload).toMatchObject({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" });
    // The name is only echoed back. Nothing reads it, so it isn't sealed.
    expect(payload).not.toHaveProperty("client_name");
    expect(payload?.exp).toBeUndefined();
  });

  it("defaults to client_secret_basic and returns a derived secret", async () => {
    const res = await register({ redirect_uris: [CLAUDE_REDIRECT] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(body.client_secret).toBe(clientSecretFor(body.client_id, key()));
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body).not.toHaveProperty("client_name");
  });

  it("registers a client_secret_post client", async () => {
    const body = await (await register({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_post" })).json();
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(body.client_secret).toBe(clientSecretFor(body.client_id, key()));
  });

  it("gives a client_id the authorization endpoint accepts", async () => {
    const body = await (await register({ redirect_uris: ["http://localhost/callback", CLAUDE_REDIRECT], token_endpoint_auth_method: "none" })).json();
    const lookup = await resolveClient(body.client_id, key());
    expect(lookup).toEqual({
      ok: true,
      client: {
        client_id: body.client_id,
        kind: "dcr",
        redirect_uris: ["http://localhost/callback", CLAUDE_REDIRECT],
        token_endpoint_auth_method: "none",
      },
    });
  });

  it("accepts null for optional fields", async () => {
    const res = await register({
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: null,
      grant_types: null,
      response_types: null,
      client_name: null,
    });
    expect(res.status).toBe(201);
  });

  it("trims, cleans and shortens client_name", async () => {
    const long = await (await register({ redirect_uris: [CLAUDE_REDIRECT], client_name: `  ${"n".repeat(150)}  ` })).json();
    expect(long.client_name).toBe("n".repeat(100));
    const sneaky = await (await register({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Cl‮aude\u0000" })).json();
    expect(sneaky.client_name).toBe("Claude");
    const blank = await (await register({ redirect_uris: [CLAUDE_REDIRECT], client_name: "   " })).json();
    expect(blank).not.toHaveProperty("client_name");
  });

  it("refuses a client_name that isn't a string", async () => {
    await expectError(await register({ redirect_uris: [CLAUDE_REDIRECT], client_name: 7 }), "invalid_client_metadata");
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["not a list", CLAUDE_REDIRECT],
    ["more than 10", Array.from({ length: 11 }, (_, i) => `https://app.example.com/cb${i}`)],
    ["plain http", ["http://app.example.com/cb"]],
    ["javascript", ["javascript:alert(1)"]],
    ["with a fragment", [`${CLAUDE_REDIRECT}#x`]],
    ["not strings", [42]],
  ])("refuses redirect_uris that are %s", async (_label, redirectUris) => {
    await expectError(await register({ redirect_uris: redirectUris }), "invalid_redirect_uri");
  });

  it("accepts 10 redirect URIs", async () => {
    const res = await register({ redirect_uris: Array.from({ length: 10 }, (_, i) => `https://app.example.com/cb${i}`) });
    expect(res.status).toBe(201);
  });

  it("refuses an unknown auth method", async () => {
    await expectError(
      await register({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "private_key_jwt" }),
      "invalid_client_metadata",
    );
  });

  it("refuses grant and response types it doesn't support", async () => {
    await expectError(
      await register({ redirect_uris: [CLAUDE_REDIRECT], grant_types: ["authorization_code", "client_credentials"] }),
      "invalid_client_metadata",
    );
    await expectError(await register({ redirect_uris: [CLAUDE_REDIRECT], grant_types: "authorization_code" }), "invalid_client_metadata");
    await expectError(await register({ redirect_uris: [CLAUDE_REDIRECT], response_types: ["token"] }), "invalid_client_metadata");
  });

  it("echoes a subset of grant types", async () => {
    const body = await (await register({ redirect_uris: [CLAUDE_REDIRECT], grant_types: ["authorization_code"] })).json();
    expect(body.grant_types).toEqual(["authorization_code"]);
  });

  it("refuses bodies that aren't a JSON object", async () => {
    await expectError(await register("{not json"), "invalid_client_metadata");
    await expectError(await register([{ redirect_uris: [CLAUDE_REDIRECT] }]), "invalid_client_metadata");
    await expectError(await register("null"), "invalid_client_metadata");
  });

  it("refuses a body over 16 KB", async () => {
    const res = await register({ redirect_uris: [CLAUDE_REDIRECT], padding: "x".repeat(17_000) });
    await expectError(res, "invalid_client_metadata");
  });

  it("refuses a registration whose client_id would be too large to use", async () => {
    const redirectUris = Array.from({ length: 10 }, (_, i) => `https://app.example.com/${i}/${"a".repeat(300)}`);
    await expectError(await register({ redirect_uris: redirectUris }), "invalid_client_metadata");
  });

  it("answers 503 when settings are missing", async () => {
    process.env.ALLOWED_EMAILS = "";
    const res = await register({ redirect_uris: [CLAUDE_REDIRECT] });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("temporarily_unavailable");
  });

  it("answers preflights", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
