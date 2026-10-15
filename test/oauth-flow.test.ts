import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui", () => ({
  htmlResponse: (
    html: string,
    options: { status?: number; headers?: HeadersInit; formActionOrigins?: string[] } = {},
  ) => {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("X-Test-Form-Action", (options.formActionOrigins ?? []).join(" "));
    return new Response(html, { status: options.status ?? 200, headers });
  },
  consentPage: (o: { clientName: string; redirectHost: string; request: string; action: string }) =>
    `consent|name=${o.clientName}|host=${o.redirectHost}|action=${o.action}|request=${o.request}`,
  errorPage: (o: { title: string; message: string }) => `error|${o.title}|${o.message}`,
  landingPage: () => "landing",
}));

import * as authorizeRoute from "@/app/authorize/route";
import * as callbackRoute from "@/app/oauth/google/callback/route";
import * as registerRoute from "@/app/register/route";
import * as tokenRoute from "@/app/token/route";
import { GOOGLE_TASKS_SCOPE, loadConfig } from "@/lib/config";
import { randomString, s256, seal, unseal } from "@/lib/crypto";
import { clearCimdCache } from "@/lib/oauth/cimd";
import type {
  AccessPayload,
  CodePayload,
  GoogleState,
  PendingAuthorization,
  RefreshPayload,
} from "@/lib/types";

const ORIGIN = "https://tasks.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const CALLBACK = `${ORIGIN}/oauth/google/callback`;
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
const CIMD_URL = "https://app.example.com/oauth/client.json";
const CSRF = "__Host-gtm_csrf";
const NONCE = "__Host-gtm_nonce";

// A stand-in for Google's token and revoke endpoints and for a client's
// metadata document host. Each test adjusts it before running the flow.
type Fake = {
  claims: Record<string, unknown>;
  scope: string;
  sendRefreshToken: boolean;
  exchangeStatus: number;
  refreshError: { status: number; error: string } | null;
  rotateRefresh: boolean;
  /** The code_challenge the server sent to Google, which the fake checks the verifier against. */
  codeChallenge?: string;
  tokenRequests: URLSearchParams[];
  revoked: string[];
  cimdDocument: unknown;
  cimdFetches: number;
  refreshCount: number;
};

let fake: Fake;

function freshFake(): Fake {
  return {
    claims: {
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      sub: "google-user-1",
      email: "owner@example.com",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    scope: `openid ${GOOGLE_TASKS_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    sendRefreshToken: true,
    exchangeStatus: 200,
    refreshError: null,
    rotateRefresh: false,
    tokenRequests: [],
    revoked: [],
    cimdDocument: {
      client_id: CIMD_URL,
      client_name: "Example App",
      redirect_uris: ["https://app.example.com/callback"],
      token_endpoint_auth_method: "none",
    },
    cimdFetches: 0,
    refreshCount: 0,
  };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeIdToken(claims: Record<string, unknown>): string {
  return [b64({ alg: "RS256", kid: "test", typ: "JWT" }), b64(claims), "c2lnbmF0dXJl"].join(".");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === GOOGLE_TOKEN_URL) {
    const body = new URLSearchParams(String(init?.body));
    fake.tokenRequests.push(body);
    if (body.get("grant_type") === "authorization_code") {
      if (fake.exchangeStatus !== 200) return jsonResponse({ error: "server_error" }, fake.exchangeStatus);
      if (body.get("code") !== "google-code") return jsonResponse({ error: "invalid_grant" }, 400);
      if (!fake.codeChallenge || s256(body.get("code_verifier") ?? "") !== fake.codeChallenge) {
        return jsonResponse({ error: "invalid_grant", error_description: "Bad code verifier." }, 400);
      }
      return jsonResponse({
        access_token: "g-access-1",
        expires_in: 3599,
        ...(fake.sendRefreshToken ? { refresh_token: "g-refresh-1" } : {}),
        scope: fake.scope,
        token_type: "Bearer",
        id_token: fakeIdToken(fake.claims),
      });
    }
    if (body.get("grant_type") === "refresh_token") {
      if (fake.refreshError) return jsonResponse({ error: fake.refreshError.error }, fake.refreshError.status);
      fake.refreshCount += 1;
      return jsonResponse({
        access_token: `g-access-r${fake.refreshCount}`,
        expires_in: 3599,
        scope: fake.scope,
        token_type: "Bearer",
        ...(fake.rotateRefresh ? { refresh_token: `g-refresh-r${fake.refreshCount}` } : {}),
      });
    }
    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }
  if (url === GOOGLE_REVOKE_URL) {
    fake.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return new Response(null, { status: 200 });
  }
  if (url === CIMD_URL) {
    fake.cimdFetches += 1;
    return jsonResponse(fake.cimdDocument);
  }
  throw new Error(`unexpected fetch to ${url}`);
}

function key(): Uint8Array {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error("test settings are missing");
  return loaded.config.tokenKey;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  clearCimdCache();
  fake = freshFake();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const name of ["ALLOWED_EMAILS", "GOOGLE_CLIENT_ID", "PUBLIC_URL"]) process.env[name] = savedEnv[name];
});

// Small HTTP helpers around the route handlers.

function cookiesFrom(res: Response): Record<string, { value: string; line: string }> {
  const out: Record<string, { value: string; line: string }> = {};
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    const index = pair.indexOf("=");
    out[pair.slice(0, index)] = { value: decodeURIComponent(pair.slice(index + 1)), line };
  }
  return out;
}

async function registerClient(body: Record<string, unknown>): Promise<{ client_id: string; client_secret?: string }> {
  const res = await registerRoute.POST(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(201);
  return res.json();
}

function registerPublic(redirectUris = [CLAUDE_REDIRECT], name = "Claude") {
  return registerClient({ redirect_uris: redirectUris, token_endpoint_auth_method: "none", client_name: name });
}

type AuthorizeParams = Record<string, string | undefined>;

function authorizeParams(clientId: string, verifier: string, overrides: AuthorizeParams = {}): AuthorizeParams {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
    state: "client-state",
    scope: "tasks offline_access",
    resource: RESOURCE,
    ...overrides,
  };
}

function getAuthorize(params: AuthorizeParams): Promise<Response> {
  const url = new URL(`${ORIGIN}/authorize`);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return authorizeRoute.GET(new Request(url));
}

function consentRequestFrom(html: string): string {
  const match = /request=(\S+)$/.exec(html);
  if (!match) throw new Error(`no consent request in ${html}`);
  return match[1];
}

function postConsent(request: string, csrf: string | undefined, decision = "allow"): Promise<Response> {
  return authorizeRoute.POST(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(csrf !== undefined ? { Cookie: `${CSRF}=${csrf}` } : {}),
      },
      body: new URLSearchParams({ request, decision }).toString(),
    }),
  );
}

function getCallback(params: Record<string, string>, nonce: string | undefined): Promise<Response> {
  const url = new URL(CALLBACK);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return callbackRoute.GET(new Request(url, { headers: nonce !== undefined ? { Cookie: `${NONCE}=${nonce}` } : {} }));
}

function postToken(params: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return tokenRoute.POST(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(params).toString(),
    }),
  );
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

/** Consent page through to Google: returns the Google redirect and the nonce cookie. */
async function toGoogle(clientId: string, verifier: string, overrides: AuthorizeParams = {}) {
  const consent = await getAuthorize(authorizeParams(clientId, verifier, overrides));
  expect(consent.status).toBe(200);
  const request = consentRequestFrom(await consent.text());
  const csrf = cookiesFrom(consent)[CSRF].value;
  const res = await postConsent(request, csrf);
  expect(res.status).toBe(303);
  const google = new URL(res.headers.get("location") ?? "");
  fake.codeChallenge = google.searchParams.get("code_challenge") ?? undefined;
  return { res, google, state: google.searchParams.get("state") ?? "", nonce: cookiesFrom(res)[NONCE].value };
}

/** The whole browser part of the sign-in: returns where the client ends up. */
async function signIn(clientId: string, verifier: string, overrides: AuthorizeParams = {}) {
  const { state, nonce } = await toGoogle(clientId, verifier, overrides);
  const res = await getCallback({ state, code: "google-code", scope: fake.scope }, nonce);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return { res, location, code: location.searchParams.get("code") ?? "" };
}

async function tokenPair(res: Response) {
  expect(res.status).toBe(200);
  const body = await res.json();
  const access = await unseal<AccessPayload>("access", body.access_token, key());
  const refresh = await unseal<RefreshPayload>("refresh", body.refresh_token, key());
  return { body, access, refresh };
}

async function expectOAuthError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect((await res.json()).error).toBe(error);
}

describe("sign-in with a DCR client", () => {
  it("runs end to end: register, consent, Google, code, token and two refreshes", async () => {
    const { client_id: clientId } = await registerPublic();
    const verifier = randomString();

    // GET /authorize shows the consent page and sets the csrf cookie.
    const consent = await getAuthorize(authorizeParams(clientId, verifier));
    expect(consent.status).toBe(200);
    const html = await consent.text();
    // Named by its redirect host, not by the client_name it registered.
    expect(html).toContain("name=claude.ai|host=claude.ai|");
    expect(html).toContain("action=/authorize");
    expect(consent.headers.get("x-test-form-action")?.split(" ")).toEqual([
      "https://accounts.google.com",
      "https://claude.ai",
    ]);
    const csrfCookie = cookiesFrom(consent)[CSRF];
    expect(csrfCookie.line).toMatch(/; Path=\//);
    expect(csrfCookie.line).toContain("Secure");
    expect(csrfCookie.line).toContain("HttpOnly");
    expect(csrfCookie.line).toContain("SameSite=Strict");
    expect(csrfCookie.line).toContain("Max-Age=600");

    const request = consentRequestFrom(html);
    const pending = await unseal<PendingAuthorization>("consent", request, key());
    expect(pending).toMatchObject({
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: s256(verifier),
      state: "client-state",
      resource: RESOURCE,
      csrf: csrfCookie.value,
    });
    expect((pending?.exp ?? 0) - (pending?.iat ?? 0)).toBe(600);

    // POST /authorize sends the person to Google.
    const toGoogleRes = await postConsent(request, csrfCookie.value);
    expect(toGoogleRes.status).toBe(303);
    expect(toGoogleRes.headers.get("cache-control")).toBe("no-store");
    const google = new URL(toGoogleRes.headers.get("location") ?? "");
    expect(`${google.origin}${google.pathname}`).toBe(GOOGLE_AUTH_URL);
    const q = google.searchParams;
    expect(q.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(CALLBACK);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(`openid email ${GOOGLE_TASKS_SCOPE}`);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("login_hint")).toBe("owner@example.com");
    fake.codeChallenge = q.get("code_challenge") ?? undefined;

    const googleState = await unseal<GoogleState>("google_state", q.get("state"), key());
    expect(googleState).toMatchObject({
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: s256(verifier),
      state: "client-state",
      resource: RESOURCE,
    });
    expect((googleState?.exp ?? 0) - (googleState?.iat ?? 0)).toBe(600);
    expect(s256(googleState?.google_verifier ?? "")).toBe(q.get("code_challenge"));

    const flowCookies = cookiesFrom(toGoogleRes);
    expect(flowCookies[NONCE].value).toBe(googleState?.nonce);
    expect(flowCookies[NONCE].line).toContain("SameSite=Lax");
    expect(flowCookies[NONCE].line).toContain("HttpOnly");
    expect(flowCookies[NONCE].line).toContain("Secure");
    expect(flowCookies[NONCE].line).toContain("Max-Age=600");
    expect(flowCookies[CSRF].value).toBe("");
    expect(flowCookies[CSRF].line).toContain("Max-Age=0");

    // Google sends the person back; the server swaps the code and redirects to the client.
    const back = await getCallback({ state: q.get("state") ?? "", code: "google-code", scope: fake.scope }, flowCookies[NONCE].value);
    expect(back.status).toBe(302);
    expect(back.headers.get("referrer-policy")).toBe("no-referrer");
    expect(cookiesFrom(back)[NONCE].line).toContain("Max-Age=0");
    const exchange = fake.tokenRequests[0];
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code",
      code: "google-code",
      code_verifier: googleState?.google_verifier,
      redirect_uri: CALLBACK,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: "test-google-client-secret",
    });

    const location = new URL(back.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    const code = location.searchParams.get("code") ?? "";
    const codePayload = await unseal<CodePayload>("code", code, key());
    expect(codePayload).toMatchObject({
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      email: "owner@example.com",
      g_refresh: "g-refresh-1",
      g_access: "g-access-1",
      resource: RESOURCE,
    });
    expect((codePayload?.exp ?? 0) - (codePayload?.iat ?? 0)).toBe(120);

    // The client exchanges the code with its PKCE verifier.
    const first = await tokenPair(
      await postToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      }),
    );
    expect(first.body).toEqual({
      access_token: expect.any(String),
      token_type: "Bearer",
      expires_in: expect.any(Number),
      refresh_token: expect.any(String),
      scope: "tasks",
    });
    expect(first.body.expires_in).toBeGreaterThan(3500);
    expect(first.body.expires_in).toBeLessThanOrEqual(3600 - 60);
    expect(first.access).toMatchObject({
      client_id: clientId,
      resource: RESOURCE,
      email: "owner@example.com",
      g_access: "g-access-1",
    });
    expect((first.access?.exp ?? 0) - (first.access?.iat ?? 0)).toBe(first.body.expires_in);
    expect(first.refresh).toMatchObject({ client_id: clientId, g_refresh: "g-refresh-1", email: "owner@example.com" });
    expect((first.refresh?.exp ?? 0) - (first.refresh?.iat ?? 0)).toBe(180 * 24 * 60 * 60);

    // Two refreshes, each with the newest refresh token.
    const second = await tokenPair(
      await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId }),
    );
    expect(second.access?.g_access).toBe("g-access-r1");
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(fake.tokenRequests[1].get("refresh_token")).toBe("g-refresh-1");
    expect(fake.tokenRequests[1].get("client_secret")).toBe("test-google-client-secret");

    const third = await tokenPair(
      await postToken({ grant_type: "refresh_token", refresh_token: second.body.refresh_token, client_id: clientId }),
    );
    expect(third.access?.g_access).toBe("g-access-r2");
    expect(third.refresh?.g_refresh).toBe("g-refresh-1");
    expect(third.body.refresh_token).not.toBe(second.body.refresh_token);
  });

  it("uses the only registered redirect_uri when the request leaves it out", async () => {
    const { client_id: clientId } = await registerPublic();
    const verifier = randomString();
    const { location, code } = await signIn(clientId, verifier, { redirect_uri: undefined });
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT);
    const res = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
  });

  it("sends access_denied back to the client when the person declines", async () => {
    const { client_id: clientId } = await registerPublic();
    const consent = await getAuthorize(authorizeParams(clientId, randomString()));
    const res = await postConsent(consentRequestFrom(await consent.text()), cookiesFrom(consent)[CSRF].value, "deny");
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(cookiesFrom(res)[CSRF].line).toContain("Max-Age=0");
    expect(cookiesFrom(res)[NONCE]).toBeUndefined();
  });

  it("sends access_denied back to the client when the person cancels at Google", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    const res = await getCallback({ state, error: "access_denied" }, nonce);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(location.searchParams.get("code")).toBeNull();
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("leaves login_hint out when more than one email is allowed", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com, partner@example.com";
    const { client_id: clientId } = await registerPublic();
    const { google } = await toGoogle(clientId, randomString());
    expect(google.searchParams.has("login_hint")).toBe(false);
  });

  it("accepts an allowed email in any case and stores it lowercased", async () => {
    fake.claims.email = "Owner@Example.COM";
    const { client_id: clientId } = await registerPublic();
    const { code } = await signIn(clientId, randomString());
    expect((await unseal<CodePayload>("code", code, key()))?.email).toBe("owner@example.com");
  });
});

describe("sign-in with a CIMD client", () => {
  it("fetches the metadata document and runs end to end as a public client", async () => {
    const verifier = randomString();
    const redirect = "https://app.example.com/callback";
    const consent = await getAuthorize(authorizeParams(CIMD_URL, verifier, { redirect_uri: redirect }));
    expect(consent.status).toBe(200);
    const html = await consent.text();
    // Named by the host of its client_id URL, not by the document's client_name.
    expect(html).toContain("name=app.example.com|host=app.example.com|");
    expect(fake.cimdFetches).toBe(1);

    const { location, code } = await signIn(CIMD_URL, verifier, { redirect_uri: redirect });
    expect(`${location.origin}${location.pathname}`).toBe(redirect);
    expect(fake.cimdFetches).toBe(1);

    const first = await tokenPair(
      await postToken({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: CIMD_URL }),
    );
    expect(first.access?.client_id).toBe(CIMD_URL);
    const second = await tokenPair(
      await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: CIMD_URL }),
    );
    expect(second.access?.g_access).toBe("g-access-r1");
  });

  it("refuses a redirect_uri the document doesn't list", async () => {
    const res = await getAuthorize(authorizeParams(CIMD_URL, randomString(), { redirect_uri: CLAUDE_REDIRECT }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a document whose client_id doesn't match", async () => {
    fake.cimdDocument = { ...(fake.cimdDocument as object), client_id: "https://other.example.com/client.json" };
    const res = await getAuthorize(authorizeParams(CIMD_URL, randomString(), { redirect_uri: "https://app.example.com/callback" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("client_id");
  });

  it("refuses a metadata URL on localhost without fetching it", async () => {
    const res = await getAuthorize(authorizeParams("https://localhost/client.json", randomString()));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loopback redirect URIs", () => {
  it("accepts a different port than the one registered and sends the code there", async () => {
    const { client_id: clientId } = await registerPublic(["http://127.0.0.1/callback"], "Claude Code");
    const verifier = randomString();
    const redirect = "http://127.0.0.1:53682/callback";

    const consent = await getAuthorize(authorizeParams(clientId, verifier, { redirect_uri: redirect }));
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("host=127.0.0.1:53682");
    expect(consent.headers.get("x-test-form-action")).toContain("http://127.0.0.1:53682");

    const { location, code } = await signIn(clientId, verifier, { redirect_uri: redirect });
    expect(location.href.startsWith(`${redirect}?`)).toBe(true);

    const otherPort = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:1234/callback",
      code_verifier: verifier,
      client_id: clientId,
    });
    await expectOAuthError(otherPort, 400, "invalid_grant");

    const res = await postToken({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId });
    expect(res.status).toBe(200);
  });

  it("does not let a different loopback host through", async () => {
    const { client_id: clientId } = await registerPublic(["http://127.0.0.1/callback"]);
    const res = await getAuthorize(authorizeParams(clientId, randomString(), { redirect_uri: "http://localhost:53682/callback" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /authorize failures", () => {
  it("shows an error page, never a redirect, for a missing or forged client", async () => {
    for (const clientId of [undefined, "not-a-client", await seal("code", { x: 1 }, key(), 60)]) {
      const res = await getAuthorize(authorizeParams(clientId as string, randomString(), { client_id: clientId }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("shows an error page for a redirect_uri the client didn't register", async () => {
    const { client_id: clientId } = await registerPublic();
    const res = await getAuthorize(authorizeParams(clientId, randomString(), { redirect_uri: "https://evil.example/cb" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("redirect_uri");
  });

  it("needs a redirect_uri when the client registered several", async () => {
    const { client_id: clientId } = await registerPublic([CLAUDE_REDIRECT, "https://claude.com/cb"]);
    const res = await getAuthorize(authorizeParams(clientId, randomString(), { redirect_uri: undefined }));
    expect(res.status).toBe(400);
  });

  // Anyone can register any redirect URI, so these never redirect there.
  async function expectErrorPage(overrides: AuthorizeParams, message: string) {
    const { client_id: clientId } = await registerPublic();
    const res = await getAuthorize(authorizeParams(clientId, randomString(), overrides));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain(message);
    expect(res.headers.getSetCookie()).toEqual([]);
  }

  it("shows an error page for a request that names only the client", async () => {
    const { client_id: clientId } = await registerPublic(["https://evil.example/fake-login"]);
    const res = await getAuthorize({ client_id: clientId });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("shows an error page for a response_type other than code", async () => {
    await expectErrorPage({ response_type: "token" }, "response_type=code");
    await expectErrorPage({ response_type: undefined }, "response_type=code");
  });

  it("shows an error page without S256 PKCE", async () => {
    await expectErrorPage({ code_challenge: undefined }, "PKCE");
    await expectErrorPage({ code_challenge: "too-short" }, "PKCE");
    await expectErrorPage({ code_challenge_method: "plain" }, "PKCE");
    await expectErrorPage({ code_challenge_method: undefined }, "PKCE");
  });

  it("shows an error page for another resource", async () => {
    await expectErrorPage({ resource: "https://other.example.com/mcp" }, RESOURCE);
    await expectErrorPage({ resource: ORIGIN }, RESOURCE);
  });

  it("tolerates a trailing slash on the resource, or no resource", async () => {
    const { client_id: clientId } = await registerPublic();
    expect((await getAuthorize(authorizeParams(clientId, randomString(), { resource: `${RESOURCE}/` }))).status).toBe(200);
    expect((await getAuthorize(authorizeParams(clientId, randomString(), { resource: undefined }))).status).toBe(200);
  });

  it("ignores unknown scopes and always grants tasks", async () => {
    const { client_id: clientId } = await registerPublic();
    const verifier = randomString();
    const { code } = await signIn(clientId, verifier, { scope: "admin everything" });
    const res = await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId });
    expect((await tokenPair(res)).body.scope).toBe("tasks");
  });

  it("refuses a request too large to carry through Google", async () => {
    await expectErrorPage({ state: "s".repeat(6000) }, "too large");
  });

  it("answers 503 when settings are missing", async () => {
    const { client_id: clientId } = await registerPublic();
    process.env.GOOGLE_CLIENT_ID = "";
    const res = await getAuthorize(authorizeParams(clientId, randomString()));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("GOOGLE_CLIENT_ID");
  });
});

describe("POST /authorize failures", () => {
  async function consentFor() {
    const { client_id: clientId } = await registerPublic();
    const consent = await getAuthorize(authorizeParams(clientId, randomString()));
    return { request: consentRequestFrom(await consent.text()), csrf: cookiesFrom(consent)[CSRF].value };
  }

  it("refuses a missing or wrong csrf cookie with 403", async () => {
    const { request } = await consentFor();
    expect((await postConsent(request, undefined)).status).toBe(403);
    const wrong = await postConsent(request, randomString());
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("location")).toBeNull();
  });

  it("refuses the csrf cookie of another consent page", async () => {
    const first = await consentFor();
    const second = await consentFor();
    expect((await postConsent(first.request, second.csrf)).status).toBe(403);
  });

  it("refuses a forged, tampered or expired request with 400", async () => {
    const { request, csrf } = await consentFor();
    expect((await postConsent("forged", csrf)).status).toBe(400);
    expect((await postConsent(`${request.slice(0, -4)}AAAA`, csrf)).status).toBe(400);

    const pending = await unseal<PendingAuthorization>("consent", request, key());
    const expired = await seal("consent", { ...pending }, key(), -60);
    const res = await postConsent(expired, csrf);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This sign-in has expired");
  });

  it("refuses an expired consent page after 10 minutes", async () => {
    const { request, csrf } = await consentFor();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 10_000);
    expect((await postConsent(request, csrf)).status).toBe(400);
  });

  it("refuses another kind of blob as the request", async () => {
    const { request, csrf } = await consentFor();
    const pending = await unseal<PendingAuthorization>("consent", request, key());
    const asState = await seal("google_state", { ...pending }, key(), 600);
    expect((await postConsent(asState, csrf)).status).toBe(400);
  });
});

describe("Google callback failures", () => {
  it("refuses a missing or wrong nonce cookie with 403", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state } = await toGoogle(clientId, randomString());
    expect((await getCallback({ state, code: "google-code" }, undefined)).status).toBe(403);
    expect((await getCallback({ state, code: "google-code" }, randomString())).status).toBe(403);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses a forged or expired state with 400", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    expect((await getCallback({ state: "forged", code: "google-code" }, nonce)).status).toBe(400);
    const opened = await unseal<GoogleState>("google_state", state, key());
    const expired = await seal("google_state", { ...opened }, key(), -60);
    expect((await getCallback({ state: expired, code: "google-code" }, nonce)).status).toBe(400);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("shows 502 when Google won't exchange the code", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    fake.exchangeStatus = 500;
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
    expect(cookiesFrom(res)[NONCE].line).toContain("Max-Age=0");
  });

  it("shows 502 when Google rejects the PKCE verifier", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    fake.codeChallenge = s256(randomString());
    expect((await getCallback({ state, code: "google-code" }, nonce)).status).toBe(502);
  });

  it("asks for the Google Tasks box when the scope wasn't granted", async () => {
    fake.scope = "openid https://www.googleapis.com/auth/userinfo.email";
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Google Tasks");
    expect(res.headers.get("location")).toBeNull();
  });

  it("shows 502 when Google sends no refresh token", async () => {
    fake.sendRefreshToken = false;
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    expect((await getCallback({ state, code: "google-code" }, nonce)).status).toBe(502);
  });

  it("refuses an email that isn't allowed, names it, and revokes the Google token", async () => {
    fake.claims.email = "stranger@example.com";
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("stranger@example.com");
    expect(res.headers.get("location")).toBeNull();
    expect(fake.revoked).toEqual(["g-refresh-1"]);
  });

  it("refuses an email that isn't allowed before checking the Tasks box or the refresh token", async () => {
    fake.claims.email = "stranger@example.com";
    fake.scope = "openid https://www.googleapis.com/auth/userinfo.email";
    fake.sendRefreshToken = false;
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("stranger@example.com");
    // With no refresh token, revoking the access token ends the grant.
    expect(fake.revoked).toEqual(["g-access-1"]);
  });

  it.each([
    ["an unverified email", { email_verified: false }],
    ["another audience", { aud: "someone-else.apps.googleusercontent.com" }],
    ["another issuer", { iss: "https://evil.example" }],
  ])("refuses an ID token with %s and revokes", async (_label, claims) => {
    Object.assign(fake.claims, claims);
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(403);
    expect(fake.revoked).toEqual(["g-refresh-1"]);
  });

  it("shows an error page rather than issue a code too large to redeem", async () => {
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const res = await fakeFetch(input, init);
      if (String(input) !== GOOGLE_TOKEN_URL) return res;
      return jsonResponse({ ...(await res.json()), access_token: "a".repeat(7000) });
    });
    const res = await getCallback({ state, code: "google-code" }, nonce);
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still shows the 403 when revoking fails", async () => {
    fake.claims.email = "stranger@example.com";
    const { client_id: clientId } = await registerPublic();
    const { state, nonce } = await toGoogle(clientId, randomString());
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === GOOGLE_REVOKE_URL) throw new Error("network down");
      return fakeFetch(input, init);
    });
    expect((await getCallback({ state, code: "google-code" }, nonce)).status).toBe(403);
  });
});

describe("POST /token failures in the flow", () => {
  async function codeFor(overrides: AuthorizeParams = {}, client?: { client_id: string }) {
    const registered = client ?? (await registerPublic());
    const verifier = randomString();
    const { code } = await signIn(registered.client_id, verifier, overrides);
    return { clientId: registered.client_id, verifier, code };
  }

  it("refuses a PKCE mismatch", async () => {
    const { clientId, code } = await codeFor();
    const res = await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: randomString(), client_id: clientId });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("refuses a redirect_uri mismatch", async () => {
    const client = await registerPublic([CLAUDE_REDIRECT, "https://claude.ai/other"]);
    const { verifier, code } = await codeFor({}, client);
    const res = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/other",
      code_verifier: verifier,
      client_id: client.client_id,
    });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("refuses a code redeemed by another client", async () => {
    const { verifier, code } = await codeFor();
    const other = await registerPublic();
    const res = await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: other.client_id });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("refuses a code after 2 minutes", async () => {
    const { clientId, verifier, code } = await codeFor();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 10_000);
    const res = await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("refuses a forged code", async () => {
    const { clientId, verifier } = await codeFor();
    const res = await postToken({ grant_type: "authorization_code", code: "forged", redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("turns Google's invalid_grant on refresh into ours", async () => {
    const { clientId, verifier, code } = await codeFor();
    const first = await tokenPair(
      await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId }),
    );
    fake.refreshError = { status: 400, error: "invalid_grant" };
    const res = await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("answers 503 temporarily_unavailable for any other Google failure", async () => {
    const { clientId, verifier, code } = await codeFor();
    const first = await tokenPair(
      await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId }),
    );
    fake.refreshError = { status: 500, error: "internal_failure" };
    await expectOAuthError(
      await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId }),
      503,
      "temporarily_unavailable",
    );
    fake.refreshError = { status: 401, error: "invalid_client" };
    await expectOAuthError(
      await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId }),
      503,
      "temporarily_unavailable",
    );
  });

  it("cuts off a refresh after the email is removed from ALLOWED_EMAILS", async () => {
    const { clientId, verifier, code } = await codeFor();
    const first = await tokenPair(
      await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId }),
    );
    process.env.ALLOWED_EMAILS = "someone-else@example.com";
    const requestsBefore = fake.tokenRequests.length;
    const res = await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId });
    await expectOAuthError(res, 400, "invalid_grant");
    expect(fake.tokenRequests).toHaveLength(requestsBefore);
  });

  it("refuses a refresh token used by another client", async () => {
    const { clientId, verifier, code } = await codeFor();
    const first = await tokenPair(
      await postToken({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: clientId }),
    );
    const other = await registerPublic();
    const res = await postToken({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: other.client_id });
    await expectOAuthError(res, 400, "invalid_grant");
  });
});

describe("confidential DCR clients", () => {
  it("authenticate with HTTP Basic", async () => {
    const client = await registerClient({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Basic App" });
    expect(client.client_secret).toBeTruthy();
    const verifier = randomString();
    const { code } = await signIn(client.client_id, verifier);
    const params = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier };

    const noSecret = await postToken({ ...params, client_id: client.client_id });
    await expectOAuthError(noSecret, 401, "invalid_client");

    const wrong = await postToken(params, { Authorization: basic(client.client_id, "wrong-secret") });
    await expectOAuthError(wrong, 401, "invalid_client");
    expect(wrong.headers.get("www-authenticate")).toMatch(/^Basic/);

    const first = await tokenPair(await postToken(params, { Authorization: basic(client.client_id, client.client_secret ?? "") }));
    expect(first.access?.client_id).toBe(client.client_id);

    const refreshed = await postToken(
      { grant_type: "refresh_token", refresh_token: first.body.refresh_token },
      { Authorization: basic(client.client_id, client.client_secret ?? "") },
    );
    expect(refreshed.status).toBe(200);
  });

  it("authenticate with client_secret_post", async () => {
    const client = await registerClient({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_post" });
    const other = await registerClient({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_post" });
    const verifier = randomString();
    const { code } = await signIn(client.client_id, verifier);
    const params = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier, client_id: client.client_id };

    await expectOAuthError(await postToken({ ...params, client_secret: other.client_secret ?? "" }), 401, "invalid_client");
    const first = await tokenPair(await postToken({ ...params, client_secret: client.client_secret ?? "" }));

    const refreshed = await postToken({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });
    expect(refreshed.status).toBe(200);
  });
});
