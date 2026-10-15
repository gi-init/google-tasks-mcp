import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPTIONS, POST } from "@/app/token/route";
import { loadConfig } from "@/lib/config";
import { clientSecretFor, randomString, s256, seal, unseal } from "@/lib/crypto";
import type { AccessPayload, CodePayload, DcrClientPayload, RefreshPayload } from "@/lib/types";

const ORIGIN = "https://tasks.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CIMD_CLIENT = "https://app.example.com/oauth/client.json";

type GoogleReply = { status: number; body: Record<string, unknown> } | "network_error";

let googleReply: GoogleReply;
let googleRequests: URLSearchParams[];

function key(): Uint8Array {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error("test settings are missing");
  return loaded.config.tokenKey;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

const saved = { ...process.env };

beforeEach(() => {
  googleRequests = [];
  googleReply = { status: 200, body: { access_token: "g-access-new", expires_in: 3599, scope: "x", token_type: "Bearer" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch to ${String(input)}`);
      googleRequests.push(new URLSearchParams(String(init?.body)));
      if (googleReply === "network_error") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(googleReply.body), {
        status: googleReply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["ALLOWED_EMAILS", "GOOGLE_CLIENT_SECRET"]) process.env[name] = saved[name];
});

async function publicClient(): Promise<string> {
  const payload: DcrClientPayload = { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
  return seal("client", payload, key());
}

async function confidentialClient(): Promise<{ id: string; secret: string }> {
  const payload: DcrClientPayload = { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" };
  const id = await seal("client", payload, key());
  return { id, secret: clientSecretFor(id, key()) };
}

async function makeCode(clientId: string, verifier: string, overrides: Partial<CodePayload> = {}): Promise<string> {
  const payload: CodePayload = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256(verifier),
    resource: RESOURCE,
    email: "owner@example.com",
    g_refresh: "g-refresh-1",
    g_access: "g-access-1",
    g_access_exp: now() + 3599,
    ...overrides,
  };
  return seal("code", payload, key(), 120);
}

async function makeRefresh(clientId: string, overrides: Partial<RefreshPayload> = {}): Promise<string> {
  const payload: RefreshPayload = {
    client_id: clientId,
    resource: RESOURCE,
    email: "owner@example.com",
    g_refresh: "g-refresh-1",
    ...overrides,
  };
  return seal("refresh", payload, key(), 180 * 24 * 3600);
}

function postForm(params: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(params).toString(),
    }),
  );
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const body = await res.json();
  expect(body.error).toBe(error);
  expect(typeof body.error_description).toBe("string");
  return body;
}

describe("POST /token basics", () => {
  it("answers preflights with CORS", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses unsupported grant types", async () => {
    const clientId = await publicClient();
    await expectError(await postForm({ grant_type: "client_credentials", client_id: clientId }), 400, "unsupported_grant_type");
    await expectError(await postForm({ grant_type: "password", client_id: clientId }), 400, "unsupported_grant_type");
    await expectError(await postForm({ client_id: clientId }), 400, "unsupported_grant_type");
  });

  it("refuses a body over 16 KB", async () => {
    const clientId = await publicClient();
    await expectError(
      await postForm({ grant_type: "refresh_token", client_id: clientId, padding: "x".repeat(17_000) }),
      400,
      "invalid_request",
    );
  });

  it("answers 503 when settings are missing", async () => {
    process.env.GOOGLE_CLIENT_SECRET = "";
    await expectError(await postForm({ grant_type: "refresh_token" }), 503, "temporarily_unavailable");
  });

  it("accepts a JSON body", async () => {
    const clientId = await publicClient();
    const verifier = randomString();
    const res = await POST(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: await makeCode(clientId, verifier),
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          client_id: clientId,
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("client authentication", () => {
  it("needs a client_id", async () => {
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: "x" }), 401, "invalid_client");
  });

  it("refuses a client_id this server didn't issue", async () => {
    await expectError(await postForm({ grant_type: "refresh_token", client_id: "made-up" }), 401, "invalid_client");
    const code = await makeCode("someone", randomString());
    await expectError(await postForm({ grant_type: "refresh_token", client_id: code }), 401, "invalid_client");
  });

  it("refuses a metadata document URL it would never fetch", async () => {
    await expectError(
      await postForm({ grant_type: "refresh_token", client_id: "https://localhost/client.json" }),
      401,
      "invalid_client",
    );
  });

  it("treats an https client_id as a public client", async () => {
    const refresh = await makeRefresh(CIMD_CLIENT);
    const res = await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: CIMD_CLIENT });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a URL client_id in HTTP Basic with an empty secret", async () => {
    const refresh = await makeRefresh(CIMD_CLIENT);
    const header = `Basic ${Buffer.from(`${encodeURIComponent(CIMD_CLIENT)}:`).toString("base64")}`;
    const res = await postForm({ grant_type: "refresh_token", refresh_token: refresh }, { Authorization: header });
    expect(res.status).toBe(200);
  });

  it("challenges a failed Basic login", async () => {
    const res = await postForm({ grant_type: "refresh_token" }, { Authorization: "Basic !!!" });
    await expectError(res, 401, "invalid_client");
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="token"');
  });

  it("refuses Basic credentials that disagree with the body", async () => {
    const client = await confidentialClient();
    const other = await confidentialClient();
    const header = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
    await expectError(await postForm({ grant_type: "refresh_token", client_id: other.id }, { Authorization: header }), 401, "invalid_client");
    await expectError(await postForm({ grant_type: "refresh_token", client_secret: "nope" }, { Authorization: header }), 401, "invalid_client");
  });

  it("tolerates Basic credentials repeated in the body", async () => {
    const client = await confidentialClient();
    const header = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
    const res = await postForm(
      { grant_type: "refresh_token", refresh_token: await makeRefresh(client.id), client_id: client.id, client_secret: client.secret },
      { Authorization: header },
    );
    expect(res.status).toBe(200);
  });

  it("refuses a confidential client without its secret, or with another client's", async () => {
    const client = await confidentialClient();
    const other = await confidentialClient();
    const refresh = await makeRefresh(client.id);
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.id }), 401, "invalid_client");
    await expectError(
      await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.id, client_secret: other.secret }),
      401,
      "invalid_client",
    );
    const ok = await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.id, client_secret: client.secret });
    expect(ok.status).toBe(200);
  });
});

describe("authorization_code grant", () => {
  it.each(["code", "redirect_uri", "code_verifier"])("requires %s", async (missing) => {
    const clientId = await publicClient();
    const verifier = randomString();
    const params: Record<string, string> = {
      grant_type: "authorization_code",
      code: await makeCode(clientId, verifier),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    };
    delete params[missing];
    await expectError(await postForm(params), 400, "invalid_request");
  });

  it("issues tokens that wrap the Google tokens", async () => {
    const clientId = await publicClient();
    const verifier = randomString();
    const res = await postForm({
      grant_type: "authorization_code",
      code: await makeCode(clientId, verifier),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("tasks");
    const access = await unseal<AccessPayload>("access", body.access_token, key());
    expect(access).toMatchObject({
      client_id: clientId,
      resource: RESOURCE,
      email: "owner@example.com",
      g_access: "g-access-1",
    });
    expect(access).not.toHaveProperty("g_refresh");
    const refresh = await unseal<RefreshPayload>("refresh", body.refresh_token, key());
    expect(refresh).toMatchObject({ client_id: clientId, g_refresh: "g-refresh-1" });
    expect(refresh).not.toHaveProperty("g_access");
    expect(googleRequests).toHaveLength(0);
  });

  it("ends the access token 60 seconds before the Google token, and at most after an hour", async () => {
    const clientId = await publicClient();
    for (const [googleLeft, expected] of [
      [3599, 3539],
      [600, 540],
      [7200, 3600],
    ]) {
      const verifier = randomString();
      const res = await postForm({
        grant_type: "authorization_code",
        code: await makeCode(clientId, verifier, { g_access_exp: now() + googleLeft }),
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: clientId,
      });
      const body = await res.json();
      expect(Math.abs(body.expires_in - expected)).toBeLessThanOrEqual(1);
      const access = await unseal<AccessPayload>("access", body.access_token, key());
      expect((access?.exp ?? 0) - (access?.iat ?? 0)).toBe(body.expires_in);
    }
  });

  it("answers 503 rather than issue an access token that is already dead", async () => {
    const clientId = await publicClient();
    const verifier = randomString();
    const res = await postForm({
      grant_type: "authorization_code",
      code: await makeCode(clientId, verifier, { g_access_exp: now() + 30 }),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    await expectError(res, 503, "temporarily_unavailable");
    expect(googleRequests).toHaveLength(0);
  });

  it("refuses a malformed code_verifier", async () => {
    const clientId = await publicClient();
    const verifier = "short";
    const res = await postForm({
      grant_type: "authorization_code",
      code: await makeCode(clientId, verifier),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    await expectError(res, 400, "invalid_grant");
  });

  it("refuses a refresh or access token passed as a code", async () => {
    const clientId = await publicClient();
    const verifier = randomString();
    const refresh = await makeRefresh(clientId);
    const params = { grant_type: "authorization_code", redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId };
    await expectError(await postForm({ ...params, code: refresh }), 400, "invalid_grant");
    const access = await seal("access", { client_id: clientId }, key(), 600);
    await expectError(await postForm({ ...params, code: access }), 400, "invalid_grant");
  });

  it("checks resource against the code", async () => {
    const clientId = await publicClient();
    const verifier = randomString();
    const params = { grant_type: "authorization_code", redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId };
    await expectError(
      await postForm({ ...params, code: await makeCode(clientId, verifier), resource: "https://other.example.com/mcp" }),
      400,
      "invalid_target",
    );
    const ok = await postForm({ ...params, code: await makeCode(clientId, verifier), resource: `${RESOURCE}/` });
    expect(ok.status).toBe(200);
  });
});

describe("refresh_token grant", () => {
  it("requires refresh_token", async () => {
    await expectError(await postForm({ grant_type: "refresh_token", client_id: await publicClient() }), 400, "invalid_request");
  });

  it("refreshes the Google token and returns a new pair", async () => {
    const clientId = await publicClient();
    const old = await makeRefresh(clientId);
    const res = await postForm({ grant_type: "refresh_token", refresh_token: old, client_id: clientId });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "tasks" });
    expect(body.refresh_token).not.toBe(old);
    expect(Object.fromEntries(googleRequests[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "g-refresh-1",
      client_id: "test-client.apps.googleusercontent.com",
      client_secret: "test-google-client-secret",
    });
    const access = await unseal<AccessPayload>("access", body.access_token, key());
    expect(access?.g_access).toBe("g-access-new");
    const refresh = await unseal<RefreshPayload>("refresh", body.refresh_token, key());
    expect(refresh?.g_refresh).toBe("g-refresh-1");
    expect((refresh?.exp ?? 0) - (refresh?.iat ?? 0)).toBe(180 * 24 * 3600);
  });

  it("keeps Google's new refresh token when Google rotates it", async () => {
    googleReply = { status: 200, body: { access_token: "g-access-new", expires_in: 3599, refresh_token: "g-refresh-2" } };
    const clientId = await publicClient();
    const res = await postForm({ grant_type: "refresh_token", refresh_token: await makeRefresh(clientId), client_id: clientId });
    const body = await res.json();
    expect((await unseal<RefreshPayload>("refresh", body.refresh_token, key()))?.g_refresh).toBe("g-refresh-2");
  });

  it("refuses a forged, expired or mistyped refresh token", async () => {
    const clientId = await publicClient();
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: "forged", client_id: clientId }), 400, "invalid_grant");
    const expired = await seal("refresh", { client_id: clientId, email: "owner@example.com", g_refresh: "x" }, key(), -60);
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: expired, client_id: clientId }), 400, "invalid_grant");
    const code = await makeCode(clientId, randomString());
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: code, client_id: clientId }), 400, "invalid_grant");
    expect(googleRequests).toHaveLength(0);
  });

  it("refuses a refresh token sealed with another key", async () => {
    const clientId = await publicClient();
    const refresh = await makeRefresh(clientId);
    process.env.GOOGLE_CLIENT_SECRET = "rotated-secret";
    // The client id was sealed with the old key too, so the client fails first.
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }), 401, "invalid_client");
    await expectError(
      await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: CIMD_CLIENT }),
      400,
      "invalid_grant",
    );
  });

  it("cuts off an email that is no longer allowed", async () => {
    const clientId = await publicClient();
    const refresh = await makeRefresh(clientId);
    process.env.ALLOWED_EMAILS = "partner@example.com";
    await expectError(await postForm({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }), 400, "invalid_grant");
    expect(googleRequests).toHaveLength(0);
  });

  it("checks resource against the refresh token", async () => {
    const clientId = await publicClient();
    const res = await postForm({
      grant_type: "refresh_token",
      refresh_token: await makeRefresh(clientId),
      client_id: clientId,
      resource: "https://other.example.com/mcp",
    });
    await expectError(res, 400, "invalid_target");
  });

  it("maps Google failures", async () => {
    const clientId = await publicClient();
    const refresh = await makeRefresh(clientId);
    const params = { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId };

    googleReply = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    await expectError(await postForm(params), 400, "invalid_grant");

    googleReply = { status: 503, body: { error: "backend_error" } };
    await expectError(await postForm(params), 503, "temporarily_unavailable");

    googleReply = "network_error";
    await expectError(await postForm(params), 503, "temporarily_unavailable");

    googleReply = { status: 200, body: { nothing: true } };
    await expectError(await postForm(params), 503, "temporarily_unavailable");
  });
});
