/** Small response helpers shared by the OAuth and metadata routes. */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

/** An RFC 6749 error body: { error, error_description }. Never cached. */
export function oauthError(
  error: string,
  description: string,
  status = 400,
  headers: HeadersInit = {},
): Response {
  return json({ error, error_description: description }, status, {
    ...NO_STORE_HEADERS,
    ...Object.fromEntries(new Headers(headers)),
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Reads a cookie from the request's Cookie header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setCookie(
  name: string,
  value: string,
  options: { maxAge: number; sameSite: "Strict" | "Lax" },
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=${options.sameSite}; Max-Age=${options.maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Reads a form or JSON body as a flat string map, with a size cap. */
export async function readParams(req: Request, maxBytes = 16_384): Promise<Record<string, string> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return null;
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) return null;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
