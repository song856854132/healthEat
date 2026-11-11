import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

// Curator owns the allergen dictionary (D18). Distinct attributes: editsCount, lastEditAt.
const CuratorProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    credentials: { type: String, maxlength: 200 },
    bio: { type: String, maxlength: 2000 },
    specialties: { type: [String], default: [] },
    publicListing: { type: Boolean, default: false },
    editsCount: { type: Number, default: 0, min: 0 },
    lastEditAt: { type: Date },
  },
  { timestamps: true },
);

export type CuratorProfileAttrs = InferSchemaType<typeof CuratorProfileSchema>;
export type CuratorProfileDoc = HydratedDocument<CuratorProfileAttrs>;
export const CuratorProfile = model("CuratorProfile", CuratorProfileSchema);
