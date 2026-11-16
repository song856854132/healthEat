import { randomUUID } from "node:crypto";

/**
 * A fresh throwaway account with a random password. There is no delete route before T5, so these
 * accounts stay in the target database; nothing in the repo can log in to them. The username fits
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
