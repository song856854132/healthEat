import app from "./app.js";
import { env } from "./lib/env.js";
import { connectDb, dbState } from "./lib/db.js";

const { PORT } = env();
app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  // Warm the connection at boot in local dev; on Vercel the first request does it (requireDb).
  if (dbState() !== "unconfigured") {
    connectDb()
      .then(() => console.log(`[api] database ${dbState()}`))
      .catch((err: unknown) =>
        console.error("[api] database connect failed:", err instanceof Error ? err.message : err),
      );
  } else {
    console.warn("[api] MONGODB_URI not set; database routes answer 503 database_unconfigured");
  }
});
