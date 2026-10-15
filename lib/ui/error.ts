import { html } from "@/lib/ui/html";
import { documentHtml, footer, wordmarkBar } from "@/lib/ui/layout";

export type ErrorPageOptions = {
  title: string;
  message: string;
};

export function errorPage(options: ErrorPageOptions): string {
  const body = html`${wordmarkBar()}
<main class="page">
<p class="eyebrow">Something went wrong</p>
<h1 class="title">${options.title}</h1>
<p class="lede">${options.message}</p>
<p class="help">You can close this page and start again from Claude, or from the app you were connecting.</p>
</main>
${footer()}`;

  return documentHtml({ title: options.title, body });
}
