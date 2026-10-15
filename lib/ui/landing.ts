import { googleCallbackUrl, resourceUrl } from "@/lib/config";
import { html, type Html } from "@/lib/ui/html";
import { checkMark, documentHtml, footer } from "@/lib/ui/layout";

export type LandingPageOptions = {
  /** e.g. https://tasks.example.com */
  origin: string;
  /** Names of settings that still need values, e.g. ["GOOGLE_CLIENT_ID"]. Empty when set up. */
  missing: string[];
};

/** Lets a long URL wrap after a slash in its path instead of in the middle of a word. */
function breakableUrl(url: string): Html {
  const pathStart = url.indexOf("/", url.indexOf("//") + 2);
  if (pathStart === -1) return html`${url}`;
  const segments = url.slice(pathStart + 1).split("/");
  return html`${url.slice(0, pathStart)}${segments.map((segment) => html`/<wbr>${segment}`)}`;
}

function setupStatus(missing: string[]): Html {
  if (missing.length === 0) {
    return html`<p class="status status-ready">Ready${checkMark("sm")}</p>
<p>Every required setting has a value.</p>`;
  }
  return html`<p class="status status-missing">Not set up yet</p>
<p>These settings still need values:</p>
<ul class="rows" role="list">
${missing.map((name) => html`<li><code>${name}</code></li>\n`)}</ul>
<p class="help">Add them as environment variables in your Vercel project, under Settings, then redeploy.</p>`;
}

/** GET / : what this is, the connector URL to paste into Claude, the Google redirect URI, and setup status. */
export function landingPage(options: LandingPageOptions): string {
  const body = html`<main>
<section class="hero">
<p class="eyebrow">Remote MCP server</p>
<h1 class="display">Google Tasks for <span class="nowrap">Claude${checkMark("lg")}</span></h1>
<p class="lede">A connector that lets Claude see, add and update the tasks in your Google Tasks. It signs you in with Google and sends each request straight to the Google Tasks API. Nothing is stored here.</p>
</section>

<section class="block" aria-labelledby="connector-url">
<h2 class="subhead" id="connector-url">Connector URL</h2>
<div class="stack">
<p class="value">${breakableUrl(resourceUrl(options.origin))}</p>
<p class="help">Paste this into Claude when you add the connector.</p>
</div>
</section>

<section class="block" aria-labelledby="setup">
<h2 class="subhead" id="setup">Setup</h2>
<div class="stack">
${setupStatus(options.missing)}
<h3 class="eyebrow">Google redirect URI</h3>
<p class="value">${breakableUrl(googleCallbackUrl(options.origin))}</p>
<p class="help">Add this under Authorized redirect URIs on your Google OAuth client.</p>
</div>
</section>

<section class="block" aria-labelledby="add-to-claude">
<h2 class="subhead" id="add-to-claude">Add it to Claude</h2>
<ol class="tasks" role="list">
<li><span class="box" aria-hidden="true"></span><span>In Claude, open <b>Customize</b>, then <b>Connectors</b>, and choose <b>Add custom connector</b>.</span></li>
<li><span class="box" aria-hidden="true"></span><span>Paste the connector URL and choose <b>Add</b>.</span></li>
<li><span class="box" aria-hidden="true"></span><span>Choose <b>Connect</b> and sign in with Google. Leave the Google Tasks box ticked.</span></li>
</ol>
</section>
</main>
${footer()}`;

  return documentHtml({
    description: "A Google Tasks connector for Claude.",
    indexable: true,
    body,
  });
}
