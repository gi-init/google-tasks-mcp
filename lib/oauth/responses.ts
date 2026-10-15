import { oauthError } from "@/lib/http";
import { errorPage, htmlResponse } from "@/lib/ui";

/** Set on the consent page, checked on the consent form post. */
export const CSRF_COOKIE = "__Host-gtm_csrf";
/** Set before leaving for Google, checked when Google sends the person back. */
export const NONCE_COOKIE = "__Host-gtm_nonce";

export function errorPageResponse(status: number, title: string, message: string, setCookie?: string): Response {
  return htmlResponse(errorPage({ title, message }), {
    status,
    headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
  });
}

export function settingsMissingPage(missing: string[]): Response {
  return errorPageResponse(
    503,
    "This server isn't set up yet",
    `These settings still need values: ${missing.join(", ")}. Add them to the deployment and try again.`,
  );
}

export function settingsMissingError(missing: string[]): Response {
  return oauthError("temporarily_unavailable", `This server is missing settings: ${missing.join(", ")}.`, 503);
}

/**
 * A redirect that never caches and never leaks this URL (which can carry a
 * code) to the next site as a Referer.
 */
export function redirectResponse(location: string, status: 302 | 303, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}
