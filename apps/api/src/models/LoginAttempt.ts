import { Schema, model, type InferSchemaType } from "mongoose";

// Failed-login counter for one username + client IP (design doc D7). The TTL index removes a window
// 15 minutes after it started; the monitor runs about once a minute, so services/throttle.ts also
// checks `windowStart` itself and never trusts a document just because it still exists.
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const LoginAttemptSchema = new Schema({
  key: { type: String, required: true, unique: true, maxlength: 320 },
  count: { type: Number, required: true, min: 0 },
  windowStart: { type: Date, required: true, expires: LOGIN_WINDOW_SECONDS },
});

export type LoginAttemptAttrs = InferSchemaType<typeof LoginAttemptSchema>;
export const LoginAttempt = model("LoginAttempt", LoginAttemptSchema);
