/**
 * Google Tasks keeps a due date, never a time: it stores midnight UTC and
 * drops anything else. The tools speak plain YYYY-MM-DD dates.
 */

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form, so 2026-02-30 is refused. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 2026-10-15 becomes 2026-10-15T00:00:00.000Z, the form Google stores. */
export function toGoogleDue(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** The date part of Google's timestamp. */
export function fromGoogleDue(due: string): string {
  return due.slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
