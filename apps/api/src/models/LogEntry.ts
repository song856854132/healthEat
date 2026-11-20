import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { LOG_SOURCES, MEALS } from "@healtheat/shared";

// One food a member ate (design doc, Data model: LogEntry). `date` is the member's calendar day in their
// own time zone (YYYY-MM-DD), so a week window is a plain string range. User to LogEntry is one of the
// rubric's one-to-many relationships.
const LogEntrySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  meal: { type: String, enum: MEALS, required: true },
  fdcId: { type: Number, required: true },
  grams: { type: Number, required: true, min: 0 },
  source: { type: String, enum: LOG_SOURCES, required: true },
  confidence: { type: Number, required: true, min: 0, max: 1 },
  photoBatchId: { type: String, default: null },
  // The client's UUID for one "log this" tap (owner decision #51); absent on entries logged without one.
  requestId: { type: String, default: undefined },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
// A member's day logs (the logs route, summaries) and every member's week (the public Home feed, T10).
LogEntrySchema.index({ userId: 1, date: 1 });
LogEntrySchema.index({ date: 1 });
// One food's week of logs (the Details page local data, T28; eng review D6).
LogEntrySchema.index({ fdcId: 1, date: 1 });
// A repeated create with the same requestId finds the first entry instead of writing a second (#51).
// Partial: entries without a requestId are never constrained.
LogEntrySchema.index(
  { userId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
);

export type LogEntryAttrs = InferSchemaType<typeof LogEntrySchema>;
export type LogEntryDoc = HydratedDocument<LogEntryAttrs>;
export const LogEntry = model("LogEntry", LogEntrySchema);
