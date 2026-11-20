import type { LocalStats } from "@healtheat/shared";
import { LogEntry, MemberProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";
import { utcWeekDates, weekEnding } from "../lib/dates.js";
import { todayIn } from "./logs.js";

// Local data on a food's Details page (T28; design doc Pages table): counts for everyone, opted-in
// usernames and the caller's own grams for signed-in callers only. One aggregate on the {fdcId, date}
// index, grouped per member and date, so a popular food costs one row per logger-day, not per entry.

/** At most this many public usernames are listed. */
const MAX_PUBLIC_LOGGERS = 10;

export async function localStatsFor(
  fdcId: number,
  viewer: UserDoc | null,
  now = new Date(),
): Promise<LocalStats> {
  // Log dates are each member's local day, so a member east of UTC can already be on UTC tomorrow:
  // the public window is the 7 UTC dates ending today plus tomorrow.
  const tomorrow = utcWeekDates(new Date(now.getTime() + 86_400_000))[6]!;
  const publicFrom = utcWeekDates(now)[0]!;
  // The caller's own grams cover the caller's own week, in their time zone.
  let mine: string[] | null = null;
  if (viewer) {
    const profile = await MemberProfile.findOne({ userId: viewer._id }, { timezone: 1 }).lean();
    mine = weekEnding(todayIn(profile?.timezone ?? "UTC", now));
  }
  const from = mine && mine[0]! < publicFrom ? mine[0]! : publicFrom;
  const to = mine && mine[6]! > tomorrow ? mine[6]! : tomorrow;
  const rows = (await LogEntry.aggregate([
    { $match: { fdcId, date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { userId: "$userId", date: "$date" },
        entries: { $sum: 1 },
        grams: { $sum: "$grams" },
      },
    },
  ])) as { _id: { userId: unknown; date: string }; entries: number; grams: number }[];

  const inPublic = rows.filter((r) => r._id.date >= publicFrom && r._id.date <= tomorrow);
  const members = [...new Set(inPublic.map((r) => String(r._id.userId)))];
  const stats: LocalStats = {
    logCount7d: inPublic.reduce((n, r) => n + r.entries, 0),
    memberCount7d: members.length,
    publicLoggers: null,
    myGrams7d: null,
  };
  if (!viewer || !mine) return stats;
  const viewerId = String(viewer._id);
  stats.myGrams7d = rows
    .filter(
      (r) => String(r._id.userId) === viewerId && r._id.date >= mine[0]! && r._id.date <= mine[6]!,
    )
    .reduce((s, r) => s + r.grams, 0);
  const opted = members.length
    ? await MemberProfile.find({ userId: { $in: members }, publicLogs: true }, { userId: 1 }).lean()
    : [];
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
