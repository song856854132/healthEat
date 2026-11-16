// Structural shape of a zod issue, so apps/web does not import zod itself: the schemas come from
// @healtheat/shared and their safeParse errors carry these fields.
export type Issue = { code: string; path: PropertyKey[]; message: string };

/**
 * First zod issue per top-level field. `friendly` replaces zod's generic wording for a field
 * (return undefined to keep the schema's own message, such as the username rule).
 */
export function issuesToFieldErrors(
  issues: readonly Issue[],
  friendly: Record<string, (issue: Issue) => string | undefined> = {},
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (!key || fields[key]) continue;
    fields[key] = friendly[key]?.(issue) ?? issue.message;
  }
  return fields;
}

/** The browser's IANA time zone, sent with registration (design doc, Auth and sessions). */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
