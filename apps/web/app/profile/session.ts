import type { MeResponse } from "@healtheat/shared";

// Shared by the /profile sections that write: each acts on whatever account the session cookie names.

const SWITCHED =
  "You are no longer signed in as this account here (another tab changed the session). Reload the page.";

/**
 * The PUT and DELETE act on whatever account the session cookie names right now, not the one this page
 * shows: another tab may have logged in as someone else. Ask the server first, and refuse unless it is
 * still `username`. Resolves to an error message, or null when it is safe to go on.
 */
export async function confirmSession(
  recheck: () => Promise<MeResponse | null | undefined>,
  username: string,
): Promise<string | null> {
  const now = await recheck();
  if (now === undefined) return "Could not check your session. Try again.";
  return now?.user.username === username ? null : SWITCHED;
}
