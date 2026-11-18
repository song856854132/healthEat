import {
  VISION_APP_DAILY_LIMIT,
  VISION_DAILY_LIMIT,
  VISION_DAILY_REFUNDS,
  VISION_LIMIT_MESSAGE,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { MemberProfile, VisionDailyTotal } from "../models/index.js";
import { memberToday } from "./logs.js";

// The 20-photos-a-day counter (design doc, REST table: MemberProfile.visionUsage, reset when the date
// changes; T13). "Today" is the member's local date, like every other today in the app. A photo is
// reserved before the Claude call and refunded if the call fails, up to VISION_DAILY_REFUNDS a day.
//
// The stored day only moves forward. A member can edit their time zone, which can move "today" a day
// back or ahead; a counter that reset on any different date would let a member switch zones back and
// forth for a fresh 20 each time. Here an earlier date keeps today's count, so a zone change gains at
// most the one day it really moves ahead.

export type Reservation = { date: string; count: number };

/**
 * Count one photo for today, atomically, or throw 429 `vision_limit` at the limit. Two writes cover the
 * two shapes: the stored day's counter below the limit is incremented in place; a counter from an
 * earlier day (or none) is replaced by today's first photo. Losing that replace race to a concurrent
 * request falls back to the increment, so concurrent first photos of the day count once each.
 */
export async function reservePhoto(userId: Types.ObjectId, now = new Date()): Promise<Reservation> {
  const today = await memberToday(userId, now);
  const increment = () =>
    MemberProfile.findOneAndUpdate(
      {
        userId,
        "visionUsage.date": { $gte: today },
        "visionUsage.count": { $lt: VISION_DAILY_LIMIT },
      },
      { $inc: { "visionUsage.count": 1 } },
      { returnDocument: "after", projection: { visionUsage: 1 } },
    ).lean();
  const firstToday = () =>
    MemberProfile.findOneAndUpdate(
      {
        userId,
        $or: [{ "visionUsage.date": { $exists: false } }, { "visionUsage.date": { $lt: today } }],
      },
      { $set: { visionUsage: { date: today, count: 1, refunds: 0 } } },
      { returnDocument: "after", projection: { visionUsage: 1 } },
    ).lean();

  const doc = (await increment()) ?? (await firstToday()) ?? (await increment());
  if (!doc?.visionUsage?.date) {
    // Register always creates the profile; a member without one is a data problem, not a full day.
    if (!(await MemberProfile.exists({ userId }))) {
      throw new HttpError(409, "member_profile_missing", "Open your profile once, then try again", {
        expose: true,
      });
    }
    throw new HttpError(429, "vision_limit", VISION_LIMIT_MESSAGE, { expose: true });
  }
  return { date: doc.visionUsage.date, count: doc.visionUsage.count ?? 0 };
}

/**
 * Give back a reserved photo after a failed call, unless today's refunds are used up (then the failed
 * call counts, since Anthropic billed it). A day that has since rolled over is left alone. Returns
 * whether the photo was given back.
 */
export async function refundPhoto(
  userId: Types.ObjectId,
  reservation: Reservation,
): Promise<boolean> {
  const res = await MemberProfile.updateOne(
    {
      userId,
      "visionUsage.date": reservation.date,
      "visionUsage.count": { $gt: 0 },
      $or: [
        { "visionUsage.refunds": { $exists: false } },
        { "visionUsage.refunds": { $lt: VISION_DAILY_REFUNDS } },
      ],
    },
    { $inc: { "visionUsage.count": -1, "visionUsage.refunds": 1 } },
  );
  return res.modifiedCount === 1;
}

/**
 * Take one of the app's photo calls for this UTC day, atomically, or throw 503 vision_unavailable at the
 * app-wide ceiling. The filter only matches a day below the ceiling; at the ceiling the upsert tries to
 * insert a second document for the day and fails on the duplicate _id, which reads as "full".
 * Returns the UTC day taken, for releaseAppCall.
 */
export async function reserveAppCall(now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  try {
    await VisionDailyTotal.updateOne(
      { _id: day, count: { $lt: VISION_APP_DAILY_LIMIT } },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    throw new HttpError(
      503,
      "vision_unavailable",
      "Photo logging has reached today's limit; try tomorrow",
      {
        expose: true,
      },
    );
  }
  return day;
}

/** Give back an app-wide call that never reached Claude (the member's own limit stopped it first). */
export async function releaseAppCall(day: string): Promise<void> {
  await VisionDailyTotal.updateOne({ _id: day, count: { $gt: 0 } }, { $inc: { count: -1 } });
}
