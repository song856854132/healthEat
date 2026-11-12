import { HttpError } from "../lib/http.js";
import { LOGIN_WINDOW_SECONDS, LoginAttempt } from "../models/LoginAttempt.js";

/** Failures allowed per key inside one window; the next login attempt answers 429 (design doc D7). */
export const MAX_LOGIN_FAILURES = 10;
const WINDOW_MS = LOGIN_WINDOW_SECONDS * 1000;

// Same pattern as services/auth.ts: build the unique + TTL indexes once per warm instance, forget a
// rejection so the next request retries. The unique `key` index is what makes recordFailure's upsert
// race-safe.
let indexesReady: Promise<unknown> | undefined;
const ensureIndexes = () =>
  (indexesReady ??= LoginAttempt.createIndexes().catch((err: unknown) => {
    indexesReady = undefined;
    throw err;
  }));

/**
 * Counter key: normalized username plus the client IP Express derived (`trust proxy` 1). Behind the
 * Next.js rewrite on Vercel the IP may be a shared hop, which makes the key effectively per-username
 * (apps/api/README.md, Login throttle).
 */
export const throttleKey = (username: string, ip: string | undefined): string =>
  `${username.trim().toLowerCase()}|${ip ?? "unknown"}`;

/**
 * Refuse the attempt while the key has MAX_LOGIN_FAILURES failures in a live window. Runs before the
 * bcrypt compare, so a locked key costs one indexed read and the right password does not unlock it.
 */
export async function assertNotLocked(key: string, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const attempt = await LoginAttempt.findOne({
    key,
    windowStart: { $gt: cutoff },
    count: { $gte: MAX_LOGIN_FAILURES },
  }).lean();
  if (!attempt) return;
  const retryAfter = Math.max(
    1,
    Math.ceil((attempt.windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000),
  );
  const minutes = Math.ceil(retryAfter / 60);
  throw new HttpError(
    429,
    "too_many_attempts",
    `too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
    { "Retry-After": String(retryAfter) },
  );
}

/**
 * Count one failure in a single atomic update: inside a live window `count + 1`, otherwise (expired or
 * no document) a new window starting now with count 1. Two first failures racing on a new key collide
 * on the unique index; the loser retries once and then lands in the winner's window.
 */
export async function recordFailure(key: string, now = new Date()): Promise<void> {
  await ensureIndexes();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const live = { $gt: ["$windowStart", cutoff] };
  const update = [
    {
      $set: {
        count: { $cond: [live, { $add: ["$count", 1] }, 1] },
        windowStart: { $cond: [live, "$windowStart", now] },
      },
    },
  ];
  for (let attempt = 0; ; attempt++) {
    try {
      // Native driver: an update pipeline with `$cond` is not something Mongoose casting should touch.
      await LoginAttempt.collection.updateOne({ key }, update, { upsert: true });
      return;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000 || attempt > 0) throw err;
    }
  }
}

/** A successful login resets the key (design doc D7). */
export async function clearFailures(key: string): Promise<void> {
  await LoginAttempt.deleteOne({ key });
}
