import { describe, expect, it } from "vitest";
import {
  formActionSource,
  isValidRedirectUri,
  redirectDisplayHost,
  redirectUriMatches,
  resolveRedirectUri,
  withParams,
} from "@/lib/oauth/redirect";

describe("isValidRedirectUri", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://app.example.com/cb?x=1",
    "https://xn--bcher-kva.example/cb",
    "http://localhost/callback",
    "http://localhost:33418/callback",
    "http://127.0.0.1:8080/cb",
    "http://[::1]:8080/cb",
    "com.example.app:/oauth2redirect",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "vscode://vscode.github-authentication/did-authenticate",
  ])("accepts %s", (uri) => {
    expect(isValidRedirectUri(uri)).toBe(true);
  });

  it.each([
    ["plain http", "http://example.com/cb"],
    ["http on a lookalike host", "http://localhost.example.com/cb"],
    ["http on another loopback address", "http://127.0.0.2/cb"],
    ["a fragment", "https://claude.ai/cb#frag"],
    ["an empty fragment", "https://claude.ai/cb#"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,hi"],
    ["file", "file:///etc/passwd"],
    ["vbscript", "vbscript:msgbox"],
    ["about", "about:blank"],
    ["blob", "blob:https://claude.ai/uuid"],
    ["uppercase javascript", "JavaScript:alert(1)"],
    ["credentials", "https://claude.ai@evil.example/cb"],
    ["a user and password", "https://user:pass@claude.ai/cb"],
    ["whitespace", "https://claude.ai/c b"],
    ["a trailing newline", "https://claude.ai/cb\n"],
    ["a tab inside the host", "https://cla\tude.ai/cb"],
    ["an odd host", "https://a;b.example/cb"],
    ["a relative path", "/callback"],
    ["an empty string", ""],
    ["nonsense", "not a url"],
    ["something too long", `https://claude.ai/${"a".repeat(2100)}`],
  ])("refuses %s", (_label, uri) => {
    expect(isValidRedirectUri(uri)).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isValidRedirectUri(undefined)).toBe(false);
    expect(isValidRedirectUri(42)).toBe(false);
    expect(isValidRedirectUri(["https://claude.ai/cb"])).toBe(false);
  });
});

describe("redirectUriMatches", () => {
  it("matches the exact string", () => {
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("does not normalize https URLs", () => {
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai/cb/")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://CLAUDE.ai/cb")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai:443/cb")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai/cb?x=1")).toBe(false);
  });

  it("ignores the port for a loopback http registration", () => {
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:53682/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:3000/cb", "http://127.0.0.1:4000/cb")).toBe(true);
    expect(redirectUriMatches("http://[::1]/cb", "http://[::1]:9000/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost/cb?x=1", "http://localhost:1234/cb?x=1")).toBe(true);
  });

  it("still checks scheme, host, path and query on loopback", () => {
    expect(redirectUriMatches("http://localhost/callback", "http://127.0.0.1:5000/callback")).toBe(false);
    expect(redirectUriMatches("http://localhost/callback", "https://localhost:5000/callback")).toBe(false);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:5000/other")).toBe(false);
    expect(redirectUriMatches("http://localhost/cb?x=1", "http://localhost:5000/cb?x=2")).toBe(false);
    expect(redirectUriMatches("http://localhost/cb", "http://localhost:5000/cb#x")).toBe(false);
    expect(redirectUriMatches("http://localhost/cb", "http://user@localhost:5000/cb")).toBe(false);
  });

  it("ignores the port only for loopback", () => {
    expect(redirectUriMatches("https://app.example.com/cb", "https://app.example.com:8443/cb")).toBe(false);
  });
});

describe("resolveRedirectUri", () => {
  it("uses the only registered URI when none is asked for", () => {
    expect(resolveRedirectUri(["https://claude.ai/cb"], undefined)).toBe("https://claude.ai/cb");
  });

  it("requires a choice when several are registered", () => {
    expect(resolveRedirectUri(["https://a.example/cb", "https://b.example/cb"], undefined)).toBeNull();
    expect(resolveRedirectUri(["https://a.example/cb", "https://b.example/cb"], "https://b.example/cb")).toBe(
      "https://b.example/cb",
    );
  });

  it("returns the requested loopback URI with its port", () => {
    expect(resolveRedirectUri(["http://localhost/cb"], "http://localhost:7777/cb")).toBe("http://localhost:7777/cb");
  });

  it("refuses an unregistered URI", () => {
    expect(resolveRedirectUri(["https://claude.ai/cb"], "https://evil.example/cb")).toBeNull();
  });
});

describe("withParams", () => {
  it("adds parameters and keeps the URI's own query as written", () => {
    const url = withParams("https://claude.ai/cb?keep=a%20b", { code: "c", state: "s t", iss: "https://tasks.example.com" });
    expect(url).toBe("https://claude.ai/cb?keep=a%20b&code=c&state=s+t&iss=https%3A%2F%2Ftasks.example.com");
  });

  it("leaves out undefined values", () => {
    expect(withParams("http://localhost:3000/cb", { code: "c", state: undefined })).toBe("http://localhost:3000/cb?code=c");
  });

  it("works for private-use schemes", () => {
    expect(withParams("com.example.app:/oauth2redirect", { code: "c" })).toBe("com.example.app:/oauth2redirect?code=c");
  });
});

describe("display and CSP helpers", () => {
  it("shows the host, or the scheme when there is no host", () => {
    expect(redirectDisplayHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectDisplayHost("http://localhost:33418/cb")).toBe("localhost:33418");
    expect(redirectDisplayHost("com.example.app:/oauth2redirect")).toBe("com.example.app");
  });

  it("makes form-action sources CSP can parse", () => {
    expect(formActionSource("https://claude.ai/cb")).toBe("https://claude.ai");
    expect(formActionSource("http://127.0.0.1:5000/cb")).toBe("http://127.0.0.1:5000");
    expect(formActionSource("http://[::1]:5000/cb")).toBe("http:");
    expect(formActionSource("cursor://anysphere.cursor-retrieval/cb")).toBe("cursor:");
  });
});
