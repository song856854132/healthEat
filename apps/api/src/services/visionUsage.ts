import { VISION_DAILY_LIMIT, VISION_LIMIT_MESSAGE } from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { MemberProfile } from "../models/index.js";
import { memberToday } from "./logs.js";

// The 20-photos-a-day counter (design doc, REST table: MemberProfile.visionUsage, reset when the date
// changes; T13). "Today" is the member's local date, like every other today in the app. A photo is
// reserved before the Claude call and refunded if the call fails, so failures and timeouts are free.

export type Reservation = { date: string; count: number };

/**
 * Count one photo for today, atomically, or throw 429 `vision_limit` at the limit. Two writes cover the
 * two shapes: today's counter below the limit is incremented in place; a counter from another day (or
 * none) is replaced by today's first photo. Losing that replace race to a concurrent request falls back
 * to the increment, so concurrent first photos of the day count once each.
 */
export async function reservePhoto(userId: Types.ObjectId, now = new Date()): Promise<Reservation> {
  const date = await memberToday(userId, now);
  const increment = () =>
    MemberProfile.findOneAndUpdate(
      { userId, "visionUsage.date": date, "visionUsage.count": { $lt: VISION_DAILY_LIMIT } },
      { $inc: { "visionUsage.count": 1 } },
      { new: true, projection: { visionUsage: 1 } },
    ).lean();
  const firstToday = () =>
    MemberProfile.findOneAndUpdate(
      { userId, "visionUsage.date": { $ne: date } },
      { $set: { visionUsage: { date, count: 1 } } },
      { new: true, projection: { visionUsage: 1 } },
    ).lean();

  const doc = (await increment()) ?? (await firstToday()) ?? (await increment());
  if (!doc?.visionUsage) {
    throw new HttpError(429, "vision_limit", VISION_LIMIT_MESSAGE, { expose: true });
  }
  return { date, count: doc.visionUsage.count ?? 0 };
}

/** Give back a reserved photo after a failed call. A day that has since rolled over is left alone. */
export async function refundPhoto(userId: Types.ObjectId, reservation: Reservation): Promise<void> {
  await MemberProfile.updateOne(
    { userId, "visionUsage.date": reservation.date, "visionUsage.count": { $gt: 0 } },
    { $inc: { "visionUsage.count": -1 } },
  );
}
