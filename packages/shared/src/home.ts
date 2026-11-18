import { z } from "zod";

// The anonymous Home feed (T10; design doc, Working plan amendments D9/D14): live aggregate data for
// visitors, rebuilt at most every 5 minutes. Counts only: no usernames next to foods or allergens.

/** How long a built feed is served before the next request rebuilds it. */
export const PUBLIC_FEED_MAX_AGE_MS = 5 * 60_000;

export const PublicHomeResponse = z.object({
  builtAt: z.string().datetime(),
  /** The 7 UTC dates the counts cover, ending on the server's UTC date. */
  week: z.object({ from: z.string(), to: z.string() }),
  /** The 10 most-logged foods this week. */
  foods: z.array(
    z.object({
      fdcId: z.number().int(),
      description: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
  /** The 5 allergens most often detected in this week's logged foods (log entries counted). */
  allergens: z.array(
    z.object({ key: z.string(), displayName: z.string(), count: z.number().int() }),
  ),
  /** The newest 6 accounts that opted in: members with publicLogs, curators with publicListing. */
  profiles: z.array(
    z.object({
      username: z.string(),
      badges: z.array(z.enum(["member", "curator"])),
      memberSince: z.string().datetime(),
    }),
  ),
});
export type PublicHomeResponse = z.infer<typeof PublicHomeResponse>;
