import { createHash } from "node:crypto";
import { html, trusted, type Html } from "@/lib/ui/html";
import { checkMark } from "@/lib/ui/layout";

// The home page's only script. It shows each copy button, which stays hidden
// without it, and swaps the button's icon for "Copied to clipboard" for two
// seconds after a copy. If the browser won't copy, it selects the value so it
// can be copied by hand.
const SOURCE = `
for (const button of document.querySelectorAll("button[data-copy]")) {
  if (!navigator.clipboard) break;
  const field = button.closest(".field");
  const status = field.querySelector("[role=status]");
  let timer;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      getSelection().selectAllChildren(field.querySelector(".value"));
      return;
    }
    button.classList.add("is-copied");
    status.textContent = "Copied to clipboard";
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.classList.remove("is-copied");
      status.textContent = "";
    }, 2000);
  });
}
`;

export const COPY_SCRIPT = trusted(`<script>${SOURCE}</script>`);

/** The script's CSP source, so the home page can run it and nothing else. */
export const COPY_SCRIPT_HASH = `sha256-${createHash("sha256").update(SOURCE).digest("base64")}`;

// Two overlapping sheets, square like the rest of the page.
const COPY_ICON = trusted(
  `<svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8.5" y="8.5" width="12" height="12"/><path d="M15.5 8.5v-5h-12v12h5"/></svg>`,
);

/** Lets a long URL wrap after a slash in its path instead of in the middle of a word. */
export function breakableUrl(url: string): Html {
  const pathStart = url.indexOf("/", url.indexOf("//") + 2);
  if (pathStart === -1) return html`${url}`;
  const segments = url.slice(pathStart + 1).split("/");
  return html`${url.slice(0, pathStart)}${segments.map((segment) => html`/<wbr>${segment}`)}`;
}

/** A URL in a box, with a button that copies it. The button appears only when COPY_SCRIPT runs. */
export function copyField(url: string, label: string): Html {
  return html`<div class="field">
<p class="value">${breakableUrl(url)}</p>
<button class="copy" type="button" data-copy="${url}" aria-label="${label}" hidden>${COPY_ICON}<span class="copy-done">${checkMark("xs")}Copied to clipboard</span></button>
<span class="sr-only" role="status"></span>
</div>`;
}
