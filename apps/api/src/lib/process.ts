// Installed once per process (local server and the Vercel function alike). A rejected promise that
// escapes asyncHandler must not kill the process silently or crash it without a log line.
declare global {
  var __healtheatProcessHooks: boolean | undefined;
}

export function installProcessHooks(): void {
  if (globalThis.__healtheatProcessHooks) return;
  globalThis.__healtheatProcessHooks = true;
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[api] unhandledRejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });
  process.on("uncaughtException", (err) => {
    console.error("[api] uncaughtException", err.stack ?? err.message);
  });
}
