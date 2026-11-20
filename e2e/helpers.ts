import { randomUUID } from "node:crypto";

/**
 * A fresh throwaway account with a random password. The specs do not delete it (only
 * e2e/profile.spec.ts's Delete account flow does, for its own account), so it stays in the target
 * database; nothing in the repo can log in to it. The username fits
 * USERNAME_PATTERN in @healtheat/shared (lowercase letters, digits, underscore, at most 24 chars).
 */
export function makeAccount(prefix: string) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    username: `${prefix}_${suffix}`.slice(0, 24),
    email: `${prefix}_${suffix}@example.com`,
    password: randomUUID(),
    timezone: "UTC",
  };
}

/**
 * Asserts that `check` keeps passing for `ms`, sampling every 50 ms: for "this must not change"
 * claims, where waiting until an expectation passes would succeed at once.
 */
export async function holdsFor(check: () => Promise<void>, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  do {
    await check();
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < until);
}
