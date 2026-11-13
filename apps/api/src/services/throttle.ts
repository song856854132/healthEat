import { HttpError } from "../lib/http.js";
import { LOGIN_WINDOW_SECONDS, LoginAttempt } from "../models/LoginAttempt.js";

/** Failures allowed per key inside one window; the next login attempt answers 429 (design doc D7). */
export const MAX_LOGIN_FAILURES = 10;
const WINDOW_MS = LOGIN_WINDOW_SECONDS * 1000;

// Same pattern as services/auth.ts: build the unique + TTL indexes once per warm instance, forget a
// rejection so the next request retries. The unique `key` index is what makes reserveAttempt's upsert
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
 * Reserve one login attempt for `key` before the password check, in a single atomic update: inside a
 * live window `count + 1`, otherwise (expired or no document) a new window starting now with count 1.
 * Attempts 1 to MAX_LOGIN_FAILURES go on to the bcrypt compare; any later one in the same window answers
 * 429, even with the right password. Reserving before the compare (not counting after it) is what keeps a
 * burst of concurrent requests to MAX_LOGIN_FAILURES password checks. A success deletes the counter, so
 * only failures accumulate. Two first attempts racing on a new key collide on the unique index; the loser
 * retries once and then lands in the winner's window.
 */
export async function reserveAttempt(key: string, now = new Date()): Promise<void> {
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
  let attempt: { count: number; windowStart: Date } | null = null;
  for (let tries = 0; ; tries++) {
    try {
      // Native driver: an update pipeline with `$cond` is not something Mongoose casting should touch.
      const doc = await LoginAttempt.collection.findOneAndUpdate({ key }, update, {
        upsert: true,
        returnDocument: "after",
      });
      attempt = doc && { count: doc.count as number, windowStart: doc.windowStart as Date };
      break;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000 || tries > 0) throw err;
    }
  }
  if (!attempt || attempt.count <= MAX_LOGIN_FAILURES) return;
  // The window is live (it was just counted in), so at least 1 ms remains: this is at least 1 second.
  const retryAfter = Math.ceil((attempt.windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000);
  const minutes = Math.ceil(retryAfter / 60);
  throw new HttpError(
    429,
    "too_many_attempts",
    `too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
    { "Retry-After": String(retryAfter) },
  );
}

/** A successful login resets the key (design doc D7). */
export async function clearFailures(key: string): Promise<void> {
  await LoginAttempt.deleteOne({ key });
}
