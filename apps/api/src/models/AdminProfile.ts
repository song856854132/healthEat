import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

// Admin manages accounts only (D18). Distinct attributes: grantsCount, lastAuditAt.
const AdminProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    grantsCount: { type: Number, default: 0, min: 0 },
    lastAuditAt: { type: Date },
    internalNote: { type: String, maxlength: 2000 },
  },
  { timestamps: true },
);

export type AdminProfileAttrs = InferSchemaType<typeof AdminProfileSchema>;
export type AdminProfileDoc = HydratedDocument<AdminProfileAttrs>;
export const AdminProfile = model("AdminProfile", AdminProfileSchema);
