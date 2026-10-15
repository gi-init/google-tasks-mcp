import { NO_STORE_HEADERS } from "@/lib/http";

export type HtmlResponseOptions = {
  status?: number;
  headers?: HeadersInit;
  /** Extra origins a form on this page may submit to or be redirected to (CSP form-action). */
  formActionOrigins?: string[];
};

// A scheme ("myapp:") or an http(s) origin with an optional port. Anything
// else, such as a value with a space or a semicolon, could add its own
// directive to the policy, so it is left out.
const CSP_SOURCE = /^(?:[a-z][a-z0-9+.-]*:|https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?)$/;

export function formActionSources(origins: string[] = []): string[] {
  const sources = ["'self'"];
  for (const origin of origins) {
    if (CSP_SOURCE.test(origin) && !sources.includes(origin)) sources.push(origin);
  }
  return sources;
}

export function contentSecurityPolicy(formActionOrigins: string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    `form-action ${formActionSources(formActionOrigins).join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Wraps a full HTML document with: text/html, CSP, X-Frame-Options DENY,
 * no-referrer, no-store. The caller's headers come first and the security
 * headers are set over them, so a page can add a Set-Cookie but can't loosen
 * the policy.
 */
export function htmlResponse(html: string, options: HtmlResponseOptions = {}): Response {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", contentSecurityPolicy(options.formActionOrigins));
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  return new Response(html, { status: options.status ?? 200, headers });
}
