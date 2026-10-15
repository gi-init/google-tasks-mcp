import { trusted } from "@/lib/ui/html";

/**
 * One stylesheet for every page, inlined so a page needs no other request but
 * the fonts. Colors, type roles and the two link underlines follow
 * pdcarlson.dev (app/globals.css there).
 */
export const STYLES = trusted(`
:root {
  color-scheme: dark;
  --bg: #191813;
  --fg: #f2ecda;
  --sage: #b8c7b8;
  --flare: #ff6e40;
  --fg-85: rgba(242, 236, 218, 0.85);
  --fg-75: rgba(242, 236, 218, 0.75);
  --fg-60: rgba(242, 236, 218, 0.6);
  --fg-50: rgba(242, 236, 218, 0.5);
  --fg-40: rgba(242, 236, 218, 0.4);
  --rule: rgba(242, 236, 218, 0.12);
  --frame: rgba(242, 236, 218, 0.14);
  --field-fill: rgba(242, 236, 218, 0.03);
  --display: "Fraunces", Georgia, "Times New Roman", serif;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --motion-underline: 0.25s ease;
  --motion-swap: 0.15s ease;
  --nav-height: 60px;
  --gutter: 20px;
}

@media (min-width: 72rem) {
  :root {
    --nav-height: 70px;
    --gutter: 56px;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
  border-radius: 0;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
}

body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

main {
  flex: 1;
}

h1,
h2,
h3,
p,
ul,
ol {
  margin: 0;
}

ul,
ol {
  padding: 0;
  list-style: none;
}

h1,
h2,
h3 {
  font-weight: 400;
}

b,
strong {
  font-weight: 500;
  color: var(--fg);
}

code {
  font-family: var(--mono);
  font-size: 0.94em;
}

::selection {
  background: var(--sage);
  color: var(--bg);
}

a:focus-visible,
button:focus-visible {
  outline: 2px solid var(--flare);
  outline-offset: 2px;
}

.grain {
  position: fixed;
  inset: 0;
  z-index: 9999;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0.05;
}

.eyebrow {
  font-family: var(--sans);
  font-size: clamp(12.5px, 0.5vw, 13.5px);
  font-weight: 400;
  line-height: 16px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-60);
}

/* Links are two underlines stacked on each other. A thin cream one is always
   there, and an orange one draws across it on hover or focus. */
.dul {
  --dul-color: var(--fg);
  --dul-weight: 2px;
  color: var(--dul-color);
  text-decoration: none;
  padding-bottom: 0.14em;
  background-image: linear-gradient(var(--flare), var(--flare)), linear-gradient(var(--fg-40), var(--fg-40));
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0% var(--dul-weight), 100% var(--dul-weight);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  transition: background-size var(--motion-underline), color var(--motion-swap);
}

.dul-muted {
  --dul-color: var(--fg-60);
}

.dul:focus-visible {
  background-size: 100% var(--dul-weight), 100% var(--dul-weight);
}

.dul-muted:focus-visible {
  --dul-color: var(--fg);
}

@media (hover: hover) and (pointer: fine) {
  .dul:hover {
    background-size: 100% var(--dul-weight), 100% var(--dul-weight);
  }

  .dul-muted:hover {
    --dul-color: var(--fg);
  }
}

/* The hand-drawn check. pathLength="1" on the path makes one dash the whole
   stroke, so moving the offset to 0 draws it in. The hidden start sits a
   little past 1, or the round cap shows as a dot. It rests drawn, and the
   animation only runs where motion is welcome. */
.check {
  display: inline-block;
  overflow: visible;
  fill: none;
  stroke: var(--flare);
  stroke-linecap: round;
  stroke-linejoin: round;
}

.check path {
  stroke-dasharray: 1 2;
  stroke-dashoffset: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .check path {
    animation: draw 0.7s cubic-bezier(0.65, 0, 0.35, 1) 0.35s backwards;
  }
}

@keyframes draw {
  from {
    stroke-dashoffset: 1.1;
  }
}

.check-lg {
  width: 0.7em;
  height: 0.58em;
  margin-left: 0.1em;
  stroke-width: 5;
}

.check-sm {
  width: 0.95em;
  height: 0.79em;
  margin-left: 0.3em;
  stroke-width: 6.5;
}

.check-xs {
  flex: none;
  width: 16px;
  height: 13px;
  margin-top: 6px;
  stroke: var(--sage);
  stroke-width: 7;
}

.nowrap {
  white-space: nowrap;
}

/* Header bar on the sign-in pages */
.bar {
  display: flex;
  align-items: center;
  height: var(--nav-height);
  padding: 0 var(--gutter);
  border-bottom: 1px solid var(--rule);
}

.wordmark {
  display: inline-flex;
  align-items: center;
  font-family: var(--display);
  font-style: italic;
  font-weight: 600;
  font-size: clamp(17px, 1.5vw, 20px);
  line-height: 1;
  color: var(--fg);
  text-decoration: none;
}

/* Home page */
.hero {
  padding: 72px var(--gutter) 64px;
}

.display {
  font-family: var(--display);
  font-size: clamp(40px, 8vw, 94px);
  line-height: 1;
  letter-spacing: -0.02em;
}

.hero .eyebrow {
  margin-bottom: 28px;
}

.lede {
  max-width: 620px;
  margin-top: 36px;
  font-size: clamp(17px, 1.5vw, 21px);
  line-height: 1.6;
  color: var(--fg-85);
}

.block {
  display: grid;
  gap: 16px;
  margin: 0 var(--gutter);
  padding: 40px 0;
  border-top: 1px solid var(--rule);
  color: var(--fg-75);
}

.block:last-child {
  padding-bottom: 72px;
}

.subhead {
  font-family: var(--display);
  font-style: italic;
  font-size: 24px;
  line-height: 1.3;
  color: var(--sage);
}

.stack > * + * {
  margin-top: 16px;
}

.stack > .eyebrow:not(:first-child) {
  margin-top: 36px;
}

.value {
  padding: 14px 16px;
  border: 1px solid var(--frame);
  background: var(--field-fill);
  font-family: var(--mono);
  font-size: 15px;
  line-height: 1.5;
  color: var(--fg);
  overflow-wrap: anywhere;
  -webkit-user-select: all;
  user-select: all;
}

.stack > .value + .help {
  margin-top: 12px;
}

.help {
  font-size: 15px;
  line-height: 1.5;
  color: var(--fg-60);
}

.status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--display);
  font-size: clamp(25px, 3vw, 31px);
  line-height: 1.15;
}

.status-missing {
  color: var(--flare);
}

.status-ready {
  color: var(--sage);
}

.status .check {
  width: 0.8em;
  height: 0.67em;
  margin-left: 0;
  stroke: var(--sage);
  stroke-width: 6;
}

.rows > li {
  padding: 12px 0;
  border-top: 1px solid var(--rule);
}

.rows > li:last-child {
  border-bottom: 1px solid var(--rule);
}

.rows code {
  color: var(--fg);
  overflow-wrap: anywhere;
}

/* The steps read as a to-do list: one empty box per step. */
.tasks > li {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 16px;
  padding: 18px 0;
  border-top: 1px solid var(--rule);
}

.tasks > li:last-child {
  border-bottom: 1px solid var(--rule);
}

.box {
  width: 18px;
  height: 18px;
  margin-top: 3px;
  border: 1.5px solid var(--fg-40);
}

/* Sign-in pages */
.page {
  max-width: calc(660px + 2 * var(--gutter));
  padding: 64px var(--gutter) 80px;
}

.page .eyebrow {
  margin-bottom: 24px;
}

.title {
  font-family: var(--display);
  font-size: clamp(34px, 5vw, 54px);
  line-height: 1.08;
  letter-spacing: -0.02em;
  overflow-wrap: break-word;
}

.title em {
  font-style: italic;
}

.page .lede {
  margin-top: 28px;
}

.host {
  padding: 1px 7px;
  border: 1px solid var(--frame);
  background: var(--field-fill);
  font-family: var(--mono);
  font-size: 0.86em;
  color: var(--fg);
  overflow-wrap: anywhere;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.can {
  margin-top: 40px;
}

.can h2 {
  margin-bottom: 12px;
}

.can li {
  display: flex;
  gap: 14px;
  color: var(--fg-75);
}

.page .help {
  margin-top: 24px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 40px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin: 0;
  padding: 10px 20px;
  border: 1px solid var(--fg-40);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  line-height: 1.4;
  cursor: pointer;
  transition: background-color var(--motion-swap), border-color var(--motion-swap);
}

.btn:hover,
.btn:focus-visible {
  border-color: var(--flare);
}

/* Orange on its own is too close to the resting border to count as a focus
   state, so the border also gets thicker. Padding gives the pixel back. */
.btn:focus-visible {
  outline: none;
  border-width: 2px;
  padding: 9px 19px;
}

.btn-primary {
  border-color: var(--sage);
  background: var(--sage);
  color: var(--bg);
  font-weight: 500;
}

.btn-primary:hover,
.btn-primary:focus-visible {
  border-color: var(--flare);
  background: var(--flare);
}

.btn-primary:focus-visible {
  border-width: 1px;
  padding: 10px 20px;
  outline: 2px solid var(--flare);
  outline-offset: 2px;
}

.prose > * + * {
  margin-top: 16px;
}

.prose h2 {
  margin-top: 48px;
  font-family: var(--display);
  font-style: italic;
  font-size: 24px;
  line-height: 1.3;
  color: var(--sage);
}

.prose p {
  color: var(--fg-75);
}

.foot {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px var(--gutter);
  border-top: 1px solid var(--rule);
  font-size: clamp(12.5px, 0.5vw, 13.5px);
  line-height: 1.45;
  color: var(--fg-50);
}

.foot ul {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 32px;
}

@media (min-width: 40rem) {
  .foot {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

@media (min-width: 72rem) {
  .hero {
    padding: 128px var(--gutter) 96px;
  }

  .block {
    grid-template-columns: 280px minmax(0, 640px);
    column-gap: 64px;
    padding: 56px 0;
  }

  .block:last-child {
    padding-bottom: 112px;
  }

  .subhead {
    padding-top: 5px;
  }

  .page {
    padding: 112px var(--gutter) 128px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

@media print {
  html,
  body {
    background: #fff;
    color: #000;
  }

  .grain {
    display: none;
  }
}
`);
