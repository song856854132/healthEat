#!/usr/bin/env node
// Local stand-in for a Vercel preview, started by Playwright (playwright.config.ts `webServer`) when
// BASE_URL is unset: an in-memory MongoDB, the Express API on API_PORT and the Next.js dev server on
// WEB_PORT with its /api/* rewrite pointing at that API. Same shape as production (browser -> web
// origin -> proxy -> API), minus https, so the e2e specs run on a laptop and in the pregate without a
// deployment. In CI, BASE_URL names the preview and this script is not used.
//
// Lifecycle: Playwright sends SIGTERM when the run ends; both children are killed with their process
// groups and the MongoDB is stopped. Nothing here is reachable from outside the machine.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "4000";
const log = (m) => process.stdout.write(`[e2e-stack] ${m}\n`);

const mongod = await MongoMemoryServer.create();
log(`mongodb ${mongod.getUri()}`);

const children = [];
function run(name, cmd, args, env, cwd) {
  // Direct binaries, no npm/sh wrapper and no detaching: Playwright kills this process tree when the
  // run ends, and a wrapper or a separate process group would let a server outlive it.
  const child = spawn(cmd, args, { stdio: "inherit", cwd, env: { ...process.env, ...env } });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      log(`${name} exited (${signal ?? code}); stopping the stack`);
      void stop(1);
    }
  });
  children.push(child);
  return child;
}

const bin = (name) => fileURLToPath(new URL(`../../node_modules/.bin/${name}`, import.meta.url));
run("api", bin("tsx"), ["apps/api/src/index.ts"], {
  PORT: API_PORT,
  NODE_ENV: "development",
  MONGODB_URI: mongod.getUri(),
  MONGODB_DB: "healtheat_e2e",
  // SESSION_SECRET stays unset: the API uses its local placeholder (env.ts) on a non-deployed run.
});
run(
  "web",
  bin("next"),
  ["dev", "--port", WEB_PORT],
  { API_ORIGIN: `http://localhost:${API_PORT}` },
  fileURLToPath(new URL("../../apps/web", import.meta.url)),
);
log(`web http://localhost:${WEB_PORT} -> api http://localhost:${API_PORT}`);

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.pid && c.exitCode === null) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  await mongod.stop().catch(() => undefined);
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => void stop(0));
