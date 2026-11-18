import { PUBLIC_FEED_MAX_AGE_MS, type PublicHomeResponse } from "@healtheat/shared";
import {
  Allergen,
  CuratorProfile,
  Food,
  FoodAllergen,
  LogEntry,
  MemberProfile,
  PublicFeedSnapshot,
  User,
} from "../models/index.js";

// GET /api/home/public (T10; design doc amendment D9/D14): the anonymous Home feed. A snapshot younger
// than 5 minutes is served as is. An older one is rebuilt by the one request that wins a conditional
// update on `builtAt`; the others serve the stale copy meanwhile. With no snapshot yet, a request builds
// one itself. Counts only, never usernames next to foods.

const KEY = "public-home";

/** The 7 UTC dates ending on `now`'s UTC date, oldest first. */
export function utcWeek(now: Date): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 7 }, (_, i) =>
    new Date(end - (6 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Builds the feed from this week's logs, the dictionary and the opted-in profiles. */
export async function buildFeed(now: Date): Promise<PublicHomeResponse> {
  const dates = utcWeek(now);
  const byFood = (await LogEntry.aggregate([
    { $match: { date: { $gte: dates[0], $lte: dates[6] } } },
    { $group: { _id: "$fdcId", count: { $sum: 1 } } },
  ])) as { _id: number; count: number }[];

  const top = [...byFood].sort((a, b) => b.count - a.count || a._id - b._id).slice(0, 10);
  const names = new Map(
    (
      await Food.find(
        { fdcId: { $in: top.map((t) => t._id) } },
        { fdcId: 1, description: 1 },
      ).lean()
    ).map((f) => [f.fdcId, f.description]),
  );

  const logsPerFood = new Map(byFood.map((f) => [f._id, f.count]));
  const rows = byFood.length
    ? await FoodAllergen.find(
        { fdcId: { $in: byFood.map((f) => f._id) } },
        { fdcId: 1, allergenId: 1 },
      ).lean()
    : [];
  const perAllergen = new Map<string, number>();
  for (const r of rows)
    perAllergen.set(
      String(r.allergenId),
      (perAllergen.get(String(r.allergenId)) ?? 0) + (logsPerFood.get(r.fdcId) ?? 0),
    );
  const entries = perAllergen.size
    ? await Allergen.find(
        { _id: { $in: [...perAllergen.keys()] } },
        { key: 1, displayName: 1 },
      ).lean()
    : [];
  const allergens = entries
    .map((e) => ({
      key: e.key,
      displayName: e.displayName,
      count: perAllergen.get(String(e._id)) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 5);

  const [members, curators] = await Promise.all([
    MemberProfile.find({ publicLogs: true }, { userId: 1 }).lean(),
    CuratorProfile.find({ publicListing: true }, { userId: 1 }).lean(),
  ]);
  const memberIds = new Set(members.map((m) => String(m.userId)));
  const curatorIds = new Set(curators.map((c) => String(c.userId)));
  // Eligibility is in the query, so the 6-row cap counts only accounts that earn a badge: a member who
  // opted into public logs, or a listed account that still holds the curator role.
  const users = await User.find({
    $or: [{ _id: { $in: [...memberIds] } }, { _id: { $in: [...curatorIds] }, roles: "curator" }],
    status: "active",
    deletionPending: { $ne: true },
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(6)
    .lean();
  const profiles = users.map((u) => {
    const id = String(u._id);
    const badges: ("member" | "curator")[] = [];
    if (memberIds.has(id)) badges.push("member");
    // A curator badge only for an account that still holds the role and opted into the listing.
    if (curatorIds.has(id) && u.roles.includes("curator")) badges.push("curator");
    return { username: u.username, badges, memberSince: (u.createdAt as Date).toISOString() };
  });

  return {
    builtAt: now.toISOString(),
    week: { from: dates[0]!, to: dates[6]! },
    foods: top.map((t) => ({
      fdcId: t._id,
      description: names.get(t._id) ?? null,
      count: t.count,
    })),
    allergens,
    profiles,
  };
}

/** The feed, rebuilt at most every PUBLIC_FEED_MAX_AGE_MS. */
export async function publicFeed(now = new Date()): Promise<PublicHomeResponse> {
  const snap = await PublicFeedSnapshot.findById(KEY).lean();
  if (snap?.payload && now.getTime() - snap.builtAt.getTime() < PUBLIC_FEED_MAX_AGE_MS)
    return snap.payload as PublicHomeResponse;
  if (snap?.payload) {
    // Claim the rebuild: only the request whose update matches the old builtAt aggregates.
    const claim = await PublicFeedSnapshot.updateOne(
      { _id: KEY, builtAt: snap.builtAt },
      { $set: { builtAt: now } },
    );
    if (claim.modifiedCount === 0) return snap.payload as PublicHomeResponse;
  }
  const payload = await buildFeed(now);
  await PublicFeedSnapshot.updateOne(
    { _id: KEY },
    { $set: { builtAt: now, payload } },
    { upsert: true },
  ).catch((err: unknown) => {
    // Two first requests both upserting: the other insert won and its feed is as fresh.
    if ((err as { code?: number }).code !== 11000) throw err;
  });
  return payload;
}
