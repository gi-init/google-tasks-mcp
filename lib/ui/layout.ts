import { REPO_URL } from "@/lib/config";
import { html, trusted, type Html } from "@/lib/ui/html";
import { STYLES } from "@/lib/ui/styles";

export const PRODUCT_NAME = "Google Tasks for Claude";

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400..600&family=Inter:wght@400..600&display=swap";

// The same faint film grain as pdcarlson.dev, drawn by the browser so it costs
// no request.
const GRAIN = trusted(
  `<svg class="grain" aria-hidden="true" focusable="false"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>`,
);

/** A check mark with a slight hook at the start, as if drawn with a pen. Size comes from the class. */
export function checkMark(size: "lg" | "sm" | "xs"): Html {
  return trusted(
    `<svg class="check check-${size}" viewBox="0 0 60 50" aria-hidden="true" focusable="false"><path pathLength="1" d="M5 31c3-1.5 6 .5 9 4 2.4 2.8 4.4 6 6 9.5C27 30 37 17 55 5"/></svg>`,
  );
}

export function wordmarkBar(): Html {
  return html`<header class="bar"><a class="wordmark" href="/">${PRODUCT_NAME}${checkMark("sm")}</a></header>`;
}

function externalLink(href: string, label: string): Html {
  return html`<a class="dul dul-muted" href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
}

export function footer(): Html {
  return html`<footer class="foot">
<p>Made by ${externalLink("https://pdcarlson.dev", "Paul Carlson")}</p>
<ul role="list">
<li>${externalLink(REPO_URL, "Source on GitHub")}</li>
<li><a class="dul dul-muted" href="/privacy">Privacy</a></li>
</ul>
</footer>`;
}

export type DocumentOptions = {
  /** Shown before the product name in the tab title. Omit for the home page. */
  title?: string;
  description?: string;
  /** Sign-in and error pages are kept out of search results. */
  indexable?: boolean;
  body: Html;
};

export function documentHtml(options: DocumentOptions): string {
  const title = options.title ? `${options.title} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
${options.indexable ? null : html`<meta name="robots" content="noindex, nofollow">\n`}${
    options.description ? html`<meta name="description" content="${options.description}">\n` : null
  }<title>${title}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_URL}">
<style>${STYLES}</style>
</head>
<body>
${options.body}
${GRAIN}
</body>
</html>
`.value;
}
