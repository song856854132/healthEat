import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

// One per account (every account is a member). Distinct attributes: body metrics, calorie band,
// DRI set, timezone, privacy opt-ins, vision usage counter (T13).
const MemberProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    sex: { type: String, enum: ["female", "male", "unspecified"], default: "unspecified" },
    birthYear: { type: Number, min: 1900, max: 2100 },
    heightCm: { type: Number, min: 50, max: 272 },
    weightKg: { type: Number, min: 20, max: 500 },
    activityLevel: {
      type: String,
      enum: ["sedentary", "light", "moderate", "active", "very_active"],
      default: "light",
    },
    calorieBand: { low: { type: Number, min: 0 }, high: { type: Number, min: 0 } },
    driSetKey: { type: String },
    timezone: { type: String, required: true, default: "UTC" },
    phone: { type: String, maxlength: 32 },
    publicLogs: { type: Boolean, default: false },
    showPhoneOnProfile: { type: Boolean, default: false },
    visionUsage: { date: { type: String }, count: { type: Number, default: 0 } },
  },
  { timestamps: true },
);

export type MemberProfileAttrs = InferSchemaType<typeof MemberProfileSchema>;
export type MemberProfileDoc = HydratedDocument<MemberProfileAttrs>;
export const MemberProfile = model("MemberProfile", MemberProfileSchema);
