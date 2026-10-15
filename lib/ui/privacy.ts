import { REPO_URL } from "@/lib/config";
import { html } from "@/lib/ui/html";
import { documentHtml, footer, wordmarkBar } from "@/lib/ui/layout";

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/** GET /privacy: what this server does with Google data. Google asks for one before an OAuth app is published. */
export function privacyPage(): string {
  const body = html`${wordmarkBar()}
<main class="page">
<p class="eyebrow">Privacy</p>
<h1 class="title">What this server does with your data</h1>
<div class="prose">
<h2>What it reads</h2>
<p>When you sign in, Google tells this server your email address, so it can check that your account is allowed to use it. After that, it reads and changes your tasks and task lists through the Google Tasks API, only when the app you connected, such as Claude, asks it to.</p>
<h2>What it keeps</h2>
<p>Nothing. There is no database. Your Google sign-in is sealed inside encrypted tokens that only this server can open, and the app you connected holds those tokens, not this server. Tasks pass through on their way to that app and are not saved. The hosting provider may keep ordinary request logs, such as times and IP addresses. These pages load their fonts from Google Fonts, so Google sees your IP address when a page opens.</p>
<h2>Who sees it</h2>
<p>Only the app you connected, and only what it asks for. Nothing is sold, shared with anyone else, or used for ads. Once your tasks reach Claude, Anthropic's privacy policy covers them there.</p>
<p>This server's use of information received from Google APIs follows the <a class="dul" href="${USER_DATA_POLICY}" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>How to stop it</h2>
<p>Remove the app from your Google Account at <a class="dul" href="${GOOGLE_PERMISSIONS}" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>. That ends its access right away. You can also disconnect the connector in Claude.</p>
<h2>Who runs it</h2>
<p>Each copy of this server is run by whoever deployed it, with their own Google OAuth client. The code is open source on <a class="dul" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>.</p>
</div>
</main>
${footer()}`;

  return documentHtml({ title: "Privacy", description: "What this Google Tasks connector does with your data.", indexable: true, body });
}
