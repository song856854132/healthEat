// Installed once per process (local server and the Vercel function alike).
declare global {
  var __healtheatProcessHooks: boolean | undefined;
}

export function installProcessHooks(): void {
  if (globalThis.__healtheatProcessHooks) return;
  // Test workers (vitest) own their process; an exit here would hide the real failure.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  globalThis.__healtheatProcessHooks = true;
  // A rejected promise that escaped asyncHandler: log and keep serving (the request already failed).
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[api] unhandledRejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });
  // A synchronous throw outside Express leaves the process in an undefined state (Node docs): log and
  // exit so the platform restarts a clean process instead of serving half-broken requests.
  process.on("uncaughtException", (err) => {
    console.error("[api] uncaughtException, exiting", err.stack ?? err.message);
    process.exit(1);
  });
}
