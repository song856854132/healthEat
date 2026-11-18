/** The 7 UTC calendar dates (YYYY-MM-DD) ending on `now`'s UTC date, oldest first. */
export function utcWeekDates(now: Date): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 7 }, (_, i) =>
    new Date(end - (6 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}
