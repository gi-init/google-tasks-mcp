import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKey } from "@/lib/config";
import {
  clientSecretFor,
  isValidCodeChallenge,
  isValidCodeVerifier,
  randomString,
  s256,
  safeEqual,
  seal,
  unseal,
} from "@/lib/crypto";

const key = deriveKey("test secret");
const otherKey = deriveKey("another secret");

afterEach(() => {
  vi.useRealTimers();
});

describe("seal and unseal", () => {
  it("round-trips a payload and adds iat and exp", async () => {
    const token = await seal("code", { a: 1, b: "two" }, key, 120);
    const opened = await unseal<{ a: number; b: string }>("code", token, key);
    expect(opened).toMatchObject({ a: 1, b: "two" });
    expect(opened?.exp).toBe((opened?.iat ?? 0) + 120);
    expect(opened).not.toHaveProperty("t");
  });

  it("leaves exp out when there is no lifetime", async () => {
    const opened = await unseal("client", await seal("client", { x: 1 }, key), key);
    expect(opened).not.toBeNull();
    expect(opened?.exp).toBeUndefined();
  });

  it("is encrypted, so the payload can't be read without the key", async () => {
    const token = await seal("refresh", { g_refresh: "google-refresh-secret" }, key);
    expect(token.split(".")).toHaveLength(5);
    const decoded = token
      .split(".")
      .map((part) => Buffer.from(part, "base64url").toString("latin1"))
      .join("");
    expect(decoded).not.toContain("google-refresh-secret");
  });

  it("refuses a blob of another type", async () => {
    const code = await seal("code", { a: 1 }, key, 120);
    expect(await unseal("access", code, key)).toBeNull();
    expect(await unseal("refresh", code, key)).toBeNull();
    expect(await unseal("client", code, key)).toBeNull();
  });

  it("refuses a blob sealed with another key", async () => {
    const token = await seal("access", { a: 1 }, otherKey, 60);
    expect(await unseal("access", token, key)).toBeNull();
  });

  it("refuses a tampered blob", async () => {
    const token = await seal("access", { a: 1 }, key, 60);
    const parts = token.split(".");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] ^= 1;
    parts[3] = ciphertext.toString("base64url");
    expect(await unseal("access", parts.join("."), key)).toBeNull();
  });

  it("refuses an expired blob, after a 5 second tolerance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await seal("code", { a: 1 }, key, 120);
    vi.setSystemTime(new Date("2026-01-01T00:02:04Z"));
    expect(await unseal("code", token, key)).not.toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:02:06Z"));
    expect(await unseal("code", token, key)).toBeNull();
  });

  it("refuses empty, garbage and oversized input", async () => {
    expect(await unseal("code", undefined, key)).toBeNull();
    expect(await unseal("code", null, key)).toBeNull();
    expect(await unseal("code", "", key)).toBeNull();
    expect(await unseal("code", "not.a.jwe.at.all", key)).toBeNull();
    expect(await unseal("code", "x".repeat(8193), key)).toBeNull();
  });

  it("caps blob length at 8192 characters", async () => {
    const small = await seal("code", { pad: "x".repeat(5000) }, key);
    expect(small.length).toBeLessThanOrEqual(8192);
    expect(await unseal("code", small, key)).not.toBeNull();
    const big = await seal("code", { pad: "x".repeat(7000) }, key);
    expect(big.length).toBeGreaterThan(8192);
    expect(await unseal("code", big, key)).toBeNull();
  });
});

describe("PKCE helpers", () => {
  it("computes S256 like RFC 7636 appendix B", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("accepts verifiers of 43 to 128 unreserved characters", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    // \u007e is the tilde, which RFC 7636 allows in a verifier.
    expect(isValidCodeVerifier("A-._\u007ez09".padEnd(43, "x"))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + "+")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + "=")).toBe(false);
  });

  it("accepts only 43 character base64url challenges", () => {
    expect(isValidCodeChallenge(s256(randomString()))).toBe(true);
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(42) + "\u007e")).toBe(false);
  });
});

describe("randomString", () => {
  it("makes 43 character base64url strings from 32 bytes, all different", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomString()));
    expect(values.size).toBe(50);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isValidCodeVerifier(value)).toBe(true);
    }
  });
});

describe("clientSecretFor", () => {
  it("is stable for a client and key, and differs otherwise", () => {
    expect(clientSecretFor("client-a", key)).toBe(clientSecretFor("client-a", key));
    expect(clientSecretFor("client-a", key)).not.toBe(clientSecretFor("client-b", key));
    expect(clientSecretFor("client-a", key)).not.toBe(clientSecretFor("client-a", otherKey));
    expect(clientSecretFor("client-a", key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("safeEqual", () => {
  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
