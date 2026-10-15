/**
 * A small HTML template tag. Every value placed into html`...` is escaped
 * unless it is already an Html fragment, so a caller's string can only ever
 * become text, never markup.
 */
export class Html {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** For markup and CSS written in this folder. Never pass input through this. */
export function trusted(value: string): Html {
  return new Html(value);
}

type Value = Html | Html[] | string | number | false | null | undefined;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Safe in text and in quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

function render(value: Value): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === false || value === null || value === undefined) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0];
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1];
  });
  return new Html(out);
}
