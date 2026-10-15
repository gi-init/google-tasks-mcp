import { html } from "@/lib/ui/html";
import { checkMark, documentHtml, footer, wordmarkBar } from "@/lib/ui/layout";

export type ConsentPageOptions = {
  /** The app asking, named by a host it can't fake, such as "claude.ai". */
  clientName: string;
  /** Host the person will be sent back to, e.g. "claude.ai". Shown prominently. */
  redirectHost: string;
  /** Sealed pending authorization, posted back as the hidden field `request`. */
  request: string;
  /** Where the form posts, e.g. "/authorize". */
  action: string;
};

/**
 * The page a person sees before being sent to Google. One form, method POST,
 * hidden field `request`, two submit buttons: name="decision" value="allow" and
 * name="decision" value="deny".
 */
export function consentPage(options: ConsentPageOptions): string {
  // The name comes from the client's own URLs, so <bdi> keeps right-to-left
  // text in it from reordering the sentence around it.
  const name = html`<bdi>${options.clientName}</bdi>`;
  const body = html`${wordmarkBar()}
<main class="page">
<p class="eyebrow">Connection request</p>
<h1 class="title">Use your Google Tasks with <em>${name}</em>?</h1>
<p class="lede">You'll go back to <bdi class="host">${options.redirectHost}</bdi> after signing in. If you don't know that address, close this page.</p>
<section class="can" aria-labelledby="can">
<h2 class="eyebrow" id="can">What it can do</h2>
<ul class="rows" role="list">
<li>${checkMark("xs")}<span>See your tasks and task lists</span></li>
<li>${checkMark("xs")}<span>Add, change and delete your tasks, and add task lists</span></li>
</ul>
</section>
<p class="help">Next, Google asks you to sign in. If it says it hasn't verified the app, choose Advanced, then the Go to link. Leave the Google Tasks box ticked.</p>
<form method="post" action="${options.action}">
<input type="hidden" name="request" value="${options.request}">
<div class="actions">
<button class="btn btn-primary" type="submit" name="decision" value="allow">Continue with Google</button>
<button class="btn" type="submit" name="decision" value="deny">Cancel</button>
</div>
</form>
</main>
${footer()}`;

  return documentHtml({ title: "Allow access", body });
}
