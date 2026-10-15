import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIMD_CACHE_TTL_MS,
  cimdClientIdProblem,
  clearCimdCache,
  isCimdClientId,
  loadClientMetadata,
  type FetchFn,
} from "@/lib/oauth/cimd";

const CLIENT_ID = "https://app.example.com/oauth/client.json";

function documentFor(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: "Example App",
    redirect_uris: ["https://app.example.com/callback", "http://localhost/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function fetchReturning(response: () => Response) {
  return vi.fn<FetchFn>(async () => response());
}

beforeEach(() => {
  clearCimdCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isCimdClientId and cimdClientIdProblem", () => {
  it("treats https client ids as metadata document URLs", () => {
    expect(isCimdClientId(CLIENT_ID)).toBe(true);
    expect(isCimdClientId("eyJhbGciOiJkaXIi.x.y.z.w")).toBe(false);
    expect(isCimdClientId("http://app.example.com/client.json")).toBe(false);
    expect(cimdClientIdProblem(CLIENT_ID)).toBeNull();
  });

  it.each([
    ["no path", "https://app.example.com"],
    ["only a slash", "https://app.example.com/"],
    ["localhost", "https://localhost/client.json"],
    ["a localhost subdomain", "https://evil.localhost/client.json"],
    ["an IPv4 literal", "https://127.0.0.1/client.json"],
    ["an IPv4 literal in hex", "https://0x7f.1/client.json"],
    ["a private IPv4 literal", "https://10.0.0.1/client.json"],
    ["an IPv6 literal", "https://[::1]/client.json"],
    ["a one-label host", "https://intranet/client.json"],
    ["a fragment", "https://app.example.com/client.json#x"],
    ["a query", "https://app.example.com/client.json?v=1"],
    ["an empty query", "https://app.example.com/client.json?"],
    ["a nested client_id", "https://tasks.example.com/authorize?client_id=https://app.example.com/client.json"],
    ["credentials", "https://user:pw@app.example.com/client.json"],
    ["a dot segment", "https://app.example.com/a/../client.json"],
    ["an encoded dot segment", "https://app.example.com/a/%2e%2e/client.json"],
    ["whitespace", "https://app.example.com/client .json"],
    ["something too long", `https://app.example.com/${"a".repeat(1100)}`],
  ])("refuses a client id with %s", (_label, clientId) => {
    expect(cimdClientIdProblem(clientId)).not.toBeNull();
  });
});

describe("loadClientMetadata", () => {
  it("fetches and accepts a valid document", async () => {
    const fetchFn = fetchReturning(() => jsonResponse(documentFor()));
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toEqual({
      ok: true,
      client: {
        client_id: CLIENT_ID,
        kind: "cimd",
        redirect_uris: ["https://app.example.com/callback", "http://localhost/callback"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(CLIENT_ID);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(init?.headers).get("user-agent")).toContain("google-tasks-mcp");
  });

  it("sets a 5 second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await loadClientMetadata(CLIENT_ID, fetchReturning(() => jsonResponse(documentFor())));
    expect(timeout).toHaveBeenCalledWith(5000);
  });

  it("accepts a document with no auth method and a charset on the content type", async () => {
    const doc = documentFor({ token_endpoint_auth_method: undefined });
    const fetchFn = fetchReturning(
      () => new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/json; charset=utf-8" } }),
    );
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result.ok).toBe(true);
  });

  it("caches a good document for 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchFn = fetchReturning(() => jsonResponse(documentFor()));
    await loadClientMetadata(CLIENT_ID, fetchFn);
    await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + CIMD_CACHE_TTL_MS + 1000));
    await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const bad = fetchReturning(() => new Response("nope", { status: 500 }));
    expect((await loadClientMetadata(CLIENT_ID, bad)).ok).toBe(false);
    const good = fetchReturning(() => jsonResponse(documentFor()));
    expect((await loadClientMetadata(CLIENT_ID, good)).ok).toBe(true);
  });

  it("refuses refused client ids without fetching", async () => {
    const fetchFn = fetchReturning(() => jsonResponse(documentFor()));
    const result = await loadClientMetadata("https://localhost/client.json", fetchFn);
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow redirects", async () => {
    const fetchFn = fetchReturning(
      () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/client.json" } }),
    );
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toMatchObject({ ok: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses an error status", async () => {
    const result = await loadClientMetadata(CLIENT_ID, fetchReturning(() => jsonResponse({}, { status: 404 })));
    expect(result.ok).toBe(false);
  });

  it("refuses a document that isn't served as JSON", async () => {
    const fetchFn = fetchReturning(
      () => new Response(JSON.stringify(documentFor()), { headers: { "Content-Type": "text/html" } }),
    );
    expect((await loadClientMetadata(CLIENT_ID, fetchFn)).ok).toBe(false);
  });

  it("refuses a document that says it is larger than 32 KB", async () => {
    const body = JSON.stringify(documentFor({ padding: "x".repeat(40_000) }));
    const fetchFn = fetchReturning(
      () =>
        new Response(body, {
          headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
        }),
    );
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("32 KB") });
  });

  it("stops reading a streamed document after 32 KB", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(8192).fill(0x20));
        if (pulled > 100) controller.close();
      },
    });
    const fetchFn = fetchReturning(() => new Response(stream, { headers: { "Content-Type": "application/json" } }));
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("32 KB") });
    expect(pulled).toBeLessThan(10);
  });

  it("refuses invalid JSON and non-objects", async () => {
    const notJson = fetchReturning(() => new Response("{nope", { headers: { "Content-Type": "application/json" } }));
    expect((await loadClientMetadata(CLIENT_ID, notJson)).ok).toBe(false);
    const array = fetchReturning(() => jsonResponse([documentFor()]));
    expect((await loadClientMetadata(CLIENT_ID, array)).ok).toBe(false);
  });

  it("refuses a document whose client_id is not its URL", async () => {
    const fetchFn = fetchReturning(() => jsonResponse(documentFor({ client_id: "https://other.example.com/client.json" })));
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("client_id") });
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["not a list", "https://app.example.com/callback"],
    ["with a bad URI", ["https://app.example.com/callback", "http://evil.example/cb"]],
    ["with a fragment", ["https://app.example.com/callback#x"]],
  ])("refuses redirect_uris that are %s", async (_label, redirectUris) => {
    const fetchFn = fetchReturning(() => jsonResponse(documentFor({ redirect_uris: redirectUris })));
    expect((await loadClientMetadata(CLIENT_ID, fetchFn)).ok).toBe(false);
  });

  it("refuses a document that asks for a client secret", async () => {
    const fetchFn = fetchReturning(() => jsonResponse(documentFor({ token_endpoint_auth_method: "client_secret_basic" })));
    expect((await loadClientMetadata(CLIENT_ID, fetchFn)).ok).toBe(false);
  });

  it("refuses when the fetch fails or times out", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await loadClientMetadata(CLIENT_ID, fetchFn);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("could not be fetched") });
  });
});
