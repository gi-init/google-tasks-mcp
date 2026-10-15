/**
 * HTML pages: the home page, the consent page and error pages.
 *
 * Every string a caller passes in is HTML-escaped. The only JavaScript is the home page's copy
 * script, which the CSP allows by its hash. Styling is inline CSS in the page, and htmlResponse
 * adds the security headers.
 *
 * The pages are built with the html`...` tag in lib/ui/html.ts, which escapes
 * every value it is given unless that value is itself a fragment from the tag.
 */

export { htmlResponse } from "@/lib/ui/response";
export { landingPage } from "@/lib/ui/landing";
export { COPY_SCRIPT_HASH } from "@/lib/ui/copy";
export { consentPage } from "@/lib/ui/consent";
export { errorPage } from "@/lib/ui/error";
export { privacyPage } from "@/lib/ui/privacy";
