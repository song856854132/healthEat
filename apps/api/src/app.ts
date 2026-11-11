// Vercel's zero-config Express support looks for app|index|server.{ts,js} in the project
// root or src/ that imports express and exports the app (or calls listen). This file is the
// deployable entry; src/index.ts only adds `listen` for local development.
import express from "express";
import cookieParser from "cookie-parser";
import { assertProductionSecrets, env } from "./lib/env.js";
import { installProcessHooks } from "./lib/process.js";
import { healthRouter } from "./routes/health.js";
import { spikeRouter } from "./routes/spike.js";
import { errorHandler, notFound } from "./middleware/error.js";

installProcessHooks();
assertProductionSecrets();

const app = express();

// One hop in front of us on Vercel (and the Next.js rewrite proxy): trust it for proto/ip.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(env().SESSION_SECRET));

app.use("/api", healthRouter);
app.use("/api/spike", spikeRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
