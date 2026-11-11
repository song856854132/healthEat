// Vercel's zero-config Express support looks for app|index|server.{ts,js} in the project
// root or src/ that imports express and exports the app (or calls listen). This file is the
// deployable entry; src/index.ts only adds `listen` for local development.
import express from "express";
import cookieParser from "cookie-parser";
import { env, secretsState } from "./lib/env.js";
import { secretsGuard } from "./middleware/secrets.js";
import { installProcessHooks } from "./lib/process.js";
import { healthRouter } from "./routes/health.js";
import { spikeRouter } from "./routes/spike.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { requireDb } from "./lib/db.js";
import { sessionMiddleware } from "./lib/session.js";
import { errorHandler, notFound } from "./middleware/error.js";

installProcessHooks();
if (secretsState() === "missing")
  console.error(
    "[api] SESSION_SECRET is unset on a deployed environment; all routes except /api/health answer 503",
  );

const app = express();

// One hop in front of us on Vercel (and the Next.js rewrite proxy): trust it for proto/ip.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(env().SESSION_SECRET));
app.use(secretsGuard(secretsState));

app.use("/api", healthRouter);
app.use("/api/spike", spikeRouter);

// Session-backed resources: a live database first (503 database_unavailable instead of a store
// error), then the Mongo-backed session, then the router. Health and the spike stay database-free.
const withSession = [requireDb, sessionMiddleware()];
app.use("/api/auth", ...withSession, authRouter);
app.use("/api/users", ...withSession, usersRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
