import { isValidTimeZone } from "@healtheat/shared";

/**
 * First message per field from zod's `error.flatten(mapper).fieldErrors`. The pages pass a mapper
 * that swaps zod's generic wording for friendlier text where it helps.
 */
export function firstPerField(
  fieldErrors: Partial<Record<string, readonly string[]>>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    if (messages?.[0]) fields[key] = messages[0];
  }
  return fields;
}

/** Sent when the browser reports no usable zone; the account's time zone can be corrected later. */
export const FALLBACK_TIME_ZONE = "UTC";

/**
 * The browser's IANA time zone, sent with registration (design doc, Auth and sessions). Falls back to
 * UTC when the browser reports none, or one this runtime cannot compute dates in ("Etc/Unknown"):
 * the form has no time zone input, so a bad value would block registration for good.
 */
export function browserTimeZone(): string {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return tz && isValidTimeZone(tz) ? tz : FALLBACK_TIME_ZONE;
}
