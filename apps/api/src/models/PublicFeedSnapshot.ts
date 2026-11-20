import { Schema, model } from "mongoose";

// The anonymous Home feed, built at most every 5 minutes (T10; D14). One document with a fixed key:
// `builtAt` doubles as the rebuild claim, so concurrent requests aggregate once.
const PublicFeedSnapshotSchema = new Schema({
  _id: { type: String, required: true },
  builtAt: { type: Date, required: true },
  payload: { type: Schema.Types.Mixed, default: null },
});

export const PublicFeedSnapshot = model("PublicFeedSnapshot", PublicFeedSnapshotSchema);
