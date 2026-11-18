import type { LocalStats } from "@healtheat/shared";
import { LogEntry, MemberProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";
import { utcWeekDates } from "../lib/dates.js";

// Local data on a food's Details page (T28; design doc Pages table): counts for everyone, opted-in
// usernames and the caller's own grams for signed-in callers only. Reads the {fdcId, date} index.

/** At most this many public usernames are listed. */
const MAX_PUBLIC_LOGGERS = 10;

export async function localStatsFor(
  fdcId: number,
  viewer: UserDoc | null,
  now = new Date(),
): Promise<LocalStats> {
  const dates = utcWeekDates(now);
  const rows = (await LogEntry.find(
    { fdcId, date: { $gte: dates[0], $lte: dates[6] } },
    { userId: 1, grams: 1 },
  ).lean()) as { userId: unknown; grams: number }[];
  const members = [...new Set(rows.map((r) => String(r.userId)))];
  const stats: LocalStats = {
    logCount7d: rows.length,
    memberCount7d: members.length,
    publicLoggers: null,
    myGrams7d: null,
  };
  if (!viewer) return stats;
  const viewerId = String(viewer._id);
  stats.myGrams7d = rows
    .filter((r) => String(r.userId) === viewerId)
    .reduce((s, r) => s + r.grams, 0);
  const opted = await MemberProfile.find(
    { userId: { $in: members }, publicLogs: true },
    { userId: 1 },
  ).lean();
  const users = opted.length
    ? await User.find(
        {
          _id: { $in: opted.map((o) => o.userId) },
          status: "active",
          deletionPending: { $ne: true },
        },
        { username: 1 },
      )
        .sort({ username: 1 })
        .limit(MAX_PUBLIC_LOGGERS)
        .lean()
    : [];
  stats.publicLoggers = users.map((u) => u.username);
  return stats;
}
