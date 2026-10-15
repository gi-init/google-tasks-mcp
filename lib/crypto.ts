import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * Everything this server hands out is a sealed blob: an encrypted JWT (JWE,
 * dir + A256GCM) that only this server can open. The `t` claim names what the
 * blob is, so a code can never be replayed as a token or a client id.
 */
export type SealedType =
  | "client" // a client registered through Dynamic Client Registration
  | "consent" // a pending authorization shown on the consent page
  | "google_state" // the state sent through Google's sign-in
  | "code" // an authorization code
  | "access" // an access token
  | "refresh"; // a refresh token

type Claims = Record<string, unknown>;

export type Opened<T> = T & { iat: number; exp?: number };

export async function seal(
  type: SealedType,
  payload: Claims,
  key: Uint8Array,
  ttlSeconds?: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new EncryptJWT({ ...payload, t: type })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(now);
  if (ttlSeconds !== undefined) jwt.setExpirationTime(now + ttlSeconds);
  return jwt.encrypt(key);
}

/** Returns the payload, or null when the blob is forged, expired or of another type. */
export async function unseal<T extends Claims>(
  type: SealedType,
  token: string | null | undefined,
  key: Uint8Array,
): Promise<Opened<T> | null> {
  if (!token || token.length > 8192) return null;
  try {
    const { payload } = await jwtDecrypt(token, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      clockTolerance: 5,
    });
    if (payload.t !== type) return null;
    const { t: _t, ...rest } = payload;
    void _t;
    return rest as Opened<T>;
  } catch {
    return null;
  }
}

export function randomString(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256: base64url(sha256(verifier)). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** A code_challenge is a base64url SHA-256 digest: exactly 43 characters. */
export function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

/** The secret for a confidential DCR client. Derived, so nothing is stored. */
export function clientSecretFor(clientId: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(`client_secret:${clientId}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
