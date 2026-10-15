import { resourceUrl } from "@/lib/config";

/** RFC 8707 resource indicator check. A trailing slash is tolerated, since some clients add one. */
export function resourceMatches(value: string, expected: string): boolean {
  return value === expected || value === `${expected}/`;
}

export function isOurResource(value: string, origin: string): boolean {
  return resourceMatches(value, resourceUrl(origin));
}
