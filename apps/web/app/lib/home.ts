import {
  GapFoodsResponse,
  PublicHomeResponse,
  SummaryResponse,
  TRACKED_NUTRIENTS,
} from "@healtheat/shared";
import { getJson } from "./foods";
import type { Result } from "./foods";

// Browser-side calls for Home (T30; apps/api/README.md, REST table). Same-origin through the rewrite:
// the session cookie rides along for the member routes.

/** GET /api/home/public (T10): this week's aggregate feed, public and session-free. */
export function getPublicHome(signal?: AbortSignal): Promise<Result<PublicHomeResponse>> {
  return getJson("/api/home/public", PublicHomeResponse, { signal });
}

/** GET /api/users/me/summary (T25): this week's bands, today's meter, exposure and alerts. */
export function getSummary(signal?: AbortSignal): Promise<Result<SummaryResponse>> {
  return getJson("/api/users/me/summary", SummaryResponse, { signal });
}

/** GET /api/users/me/gaps/:nutrientId/foods (T26): the best whole foods for one tracked nutrient. */
export function getGapFoods(
  nutrientId: number,
  signal?: AbortSignal,
): Promise<Result<GapFoodsResponse>> {
  return getJson(`/api/users/me/gaps/${nutrientId}/foods`, GapFoodsResponse, { signal });
}

/** The USDA nutrient id the gap route takes for a band's key (the summary names bands by key). */
export function nutrientIdFor(key: string): number | undefined {
  return TRACKED_NUTRIENTS.find((t) => t.key === key)?.id;
}

/** "2026-11-16" -> "Nov 16". The date is a calendar date, so it is read in UTC to keep its day. */
export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
