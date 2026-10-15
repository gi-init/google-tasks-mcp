export const MAX_CLIENT_NAME_LENGTH = 100;

// Control characters and the Unicode bidi controls, which could make a name
// read differently from what it is.
const INVISIBLE = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu;

/** A client's self-chosen display name: trimmed, cleaned, at most 100 characters, or undefined. */
export function cleanClientName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(INVISIBLE, "").trim()).slice(0, MAX_CLIENT_NAME_LENGTH).join("").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
