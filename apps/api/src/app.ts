// Vercel's zero-config Express support looks for app|index|server.{ts,js} in the project
// root or src/ that imports express and exports the app (or calls listen). This file is the
// deployable entry; src/index.ts only adds `listen` for local development.
import express from "express";
import cookieParser from "cookie-parser";
import { healthRouter } from "./routes/health";
import { spikeRouter } from "./routes/spike";

const app = express();

// One hop in front of us on Vercel (and the Next.js rewrite proxy): trust it for proto/ip.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(process.env.SESSION_SECRET ?? "dev-only-change-me"));

app.use("/api", healthRouter);
app.use("/api/spike", spikeRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Central error handler: never leak stack traces, always JSON.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[api] unhandled", message);
    res.status(500).json({
      error: "internal",
      details: process.env.NODE_ENV === "production" ? undefined : message,
    });
  },
);

export default app;
