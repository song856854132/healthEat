const DAY_MS = 86_400_000;

/** The 7 calendar dates (YYYY-MM-DD) ending on `end`, oldest first. */
export function weekEnding(end: string): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(last - (6 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** The 7 UTC calendar dates ending on `now`'s UTC date, oldest first. */
export function utcWeekDates(now: Date): string[] {
  return weekEnding(now.toISOString().slice(0, 10));
}
