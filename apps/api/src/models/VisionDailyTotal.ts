import { Schema, model } from "mongoose";

// App-wide photo calls per UTC day (T13): every Claude vision call is billed, so this counter caps the
// whole app's daily spend, not just one member's. `_id` is the UTC date, YYYY-MM-DD.
const VisionDailyTotalSchema = new Schema({
  _id: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
});

export const VisionDailyTotal = model("VisionDailyTotal", VisionDailyTotalSchema);
