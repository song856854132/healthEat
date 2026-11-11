import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { ROLES, ACCOUNT_STATUSES } from "@healtheat/shared";

// Accounts are multi-role (design doc, Data model): one User plus one profile document per role in
// separate collections. `roles` always contains "member"; "curator" and "admin" are granted by an
// Admin (T7/T21). `activeRole` only selects which Home renders.
export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

const UserSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      immutable: true, // rubric: username never changes
      lowercase: true,
      trim: true,
      match: USERNAME_PATTERN,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    roles: {
      type: [{ type: String, enum: ROLES }],
      default: ["member"],
      validate: {
        validator: (v: string[]) => v.includes("member"),
        message: "every account holds the member role",
      },
    },
    status: { type: String, enum: ACCOUNT_STATUSES, default: "active" },
    activeRole: {
      type: String,
      enum: ROLES,
      default: "member",
      // Enforced on document save() only: Mongoose cannot see sibling fields in update queries. Routes
      // that change roles or activeRole (T7, T21) must load the document and save(), never updateOne.
      validate: {
        validator(this: { roles?: string[] }, v: string) {
          return Array.isArray(this.roles) ? this.roles.includes(v) : true;
        },
        message: "activeRole must be one of the account's roles",
      },
    },
    privacyAckAt: { type: Date },
    deletionPending: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

export type UserAttrs = InferSchemaType<typeof UserSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model("User", UserSchema);
