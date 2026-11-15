import {
  FOOD_SEARCH_PAGE_SIZE,
  FoodDetails,
  FoodSearchResponse,
  type FoodNutrient,
  type FoodSearchQuery,
  type FoodSummary,
  type ServingSize,
} from "@healtheat/shared";
import { usdaApiKey } from "../lib/env.js";
import { HttpError } from "../lib/http.js";
import { Food, SearchCache } from "../models/index.js";

// USDA FoodData Central proxy (design doc: REST table, D5 search cache, S7 failure handling). Every
// nutrient value the app shows comes from here, never from a model's memory.
export const USDA_BASE_URL = "https://api.nal.usda.gov/fdc/v1";
/** A stuck USDA call fails fast with a readable 503 instead of holding the function. */
export const USDA_TIMEOUT_MS = 8_000;
/** A cached search page younger than this is served without calling USDA. */
export const SEARCH_FRESH_MS = 60 * 60 * 1000;
/** A cached food older than this is re-fetched on the next read (design doc: Food, 30 days). */
export const FOOD_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

const UNAVAILABLE = "USDA is unavailable right now, try again in a few minutes";
// A message for users, so it reaches them on deployments too (HttpError `expose`).
const unavailable = () => new HttpError(503, "usda_unavailable", UNAVAILABLE, { expose: true });

// Nutrients shown on a search result row: energy (USDA reports it under 1008, or the Atwater ids
// 2047/2048 for Foundation foods), protein, fat and carbohydrate.
const HEADLINE_NUTRIENTS = new Set([1008, 2047, 2048, 1003, 1004, 1005]);

/** Why a USDA call produced no usable answer: `unavailable` may fall back to a cached copy. */
class UsdaFailure extends Error {
  constructor(readonly kind: "unavailable" | "not_found") {
    super(kind);
  }
}

async function usdaGet(path: string, params: Record<string, string>): Promise<unknown> {
  const key = usdaApiKey();
  if (!key) throw new HttpError(503, "usda_unconfigured", "USDA_API_KEY is not set");
  const url = new URL(`${USDA_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", key);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(USDA_TIMEOUT_MS) });
  } catch (err) {
    console.error("[usda]", path, "request failed:", err instanceof Error ? err.message : err);
    throw new UsdaFailure("unavailable");
  }
  if (res.status === 404 || res.status === 400) {
    // A 400 means USDA rejected what we sent (a query it cannot parse); worth a log line, never the key.
    if (res.status === 400) console.error("[usda]", path, "answered 400");
    throw new UsdaFailure("not_found");
  }
  if (!res.ok) {
    // 429 (quota), 5xx, and 401/403 (a revoked or placeholder key) all leave us without data; the
    // status goes to the log, never to the client.
    console.error("[usda]", path, "answered", res.status);
    throw new UsdaFailure("unavailable");
  }
  try {
    return await res.json();
  } catch {
    console.error("[usda]", path, "returned a body that is not JSON");
    throw new UsdaFailure("unavailable");
  }
}

const UNITS: Record<string, string> = {
  G: "g",
  MG: "mg",
  UG: "µg",
  KCAL: "kcal",
  KJ: "kJ",
  IU: "IU",
};
const unit = (u: unknown): string => (typeof u === "string" ? (UNITS[u.toUpperCase()] ?? u) : "");

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

type Raw = Record<string, unknown>;
const records = (v: unknown): Raw[] =>
  Array.isArray(v) ? v.filter((x): x is Raw => typeof x === "object" && x !== null) : [];

/** Search hits carry flat nutrients: {nutrientId, nutrientName, unitName, value}. */
function searchNutrients(raw: unknown): FoodNutrient[] {
  const out: FoodNutrient[] = [];
  for (const n of records(raw)) {
    const id = num(n.nutrientId);
    const amount = num(n.value);
    if (id === null || amount === null || !HEADLINE_NUTRIENTS.has(id)) continue;
    out.push({
      nutrientId: id,
      name: str(n.nutrientName) ?? "",
      unit: unit(n.unitName),
      amountPer100g: amount,
    });
  }
  return out;
}

/** Details carry nested nutrients: {nutrient: {id, name, unitName}, amount}; group headers have no amount. */
function detailNutrients(raw: unknown): FoodNutrient[] {
  const out: FoodNutrient[] = [];
  for (const n of records(raw)) {
    const meta = (typeof n.nutrient === "object" && n.nutrient !== null ? n.nutrient : {}) as Raw;
    const id = num(meta.id);
    const amount = num(n.amount);
    if (id === null || amount === null) continue;
    out.push({
      nutrientId: id,
      name: str(meta.name) ?? "",
      unit: unit(meta.unitName),
      amountPer100g: amount,
    });
  }
  return out;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function servingSizes(food: Raw): ServingSize[] {
  const out: ServingSize[] = [];
  // Branded foods: the label serving, in grams only (a serving in ml has no weight to log by).
  const size = num(food.servingSize);
  const sizeUnit = str(food.servingSizeUnit)?.toLowerCase();
  if (size && size > 0 && (sizeUnit === "g" || sizeUnit === "grm")) {
    const household = str(food.householdServingFullText);
    out.push({
      label: household ? `${household} (${fmt(size)} g)` : `${fmt(size)} g`,
      grams: size,
    });
  }
  // Foundation, SR Legacy and Survey foods: measured portions.
  for (const p of records(food.foodPortions)) {
    const grams = num(p.gramWeight);
    if (!grams || grams <= 0) continue;
    const measure = (
      typeof p.measureUnit === "object" && p.measureUnit !== null ? p.measureUnit : {}
    ) as Raw;
    const measureName = str(measure.name);
    const description = str(p.portionDescription);
    const label =
      description && description !== "Quantity not specified"
        ? description
        : measureName === "RACC"
          ? "1 serving (reference amount)"
          : [
              num(p.amount) ?? 1,
              measureName && measureName !== "undetermined" ? measureName : null,
              str(p.modifier),
            ]
              .filter((x) => x !== null)
              .map((x) => (typeof x === "number" ? fmt(x) : x))
              .join(" ");
    out.push({ label, grams });
  }
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.label) && seen.add(s.label));
}

function summary(food: Raw, nutrients: FoodNutrient[]): FoodSummary | null {
  const fdcId = num(food.fdcId);
  const description = str(food.description);
  if (fdcId === null || fdcId <= 0 || !Number.isInteger(fdcId) || !description) return null;
  return {
    fdcId,
    description,
    dataType: str(food.dataType) ?? "Unknown",
    brandOwner: str(food.brandOwner),
    ingredientsText: str(food.ingredients),
    nutrients,
  };
}

/** Cache key: one entry per normalized query, data type and page (D5). */
export const searchCacheKey = (q: FoodSearchQuery): string =>
  `${q.q.toLowerCase()}|${q.dataType ?? "all"}|${q.page}`;

// Two requests for the same uncached page can both try to insert it; the loser's copy is equal, so a
// duplicate key on a cache write is not an error.
const ignoreDuplicate = (err: unknown) => {
  if ((err as { code?: number }).code !== 11000) throw err;
};

type StoredSearch = Omit<FoodSearchResponse, "cached">;

const emptyPage = (q: FoodSearchQuery, now: Date): StoredSearch => ({
  query: q.q,
  dataType: q.dataType ?? null,
  page: q.page,
  pageSize: FOOD_SEARCH_PAGE_SIZE,
  totalPages: 0,
  totalHits: 0,
  foods: [],
  fetchedAt: now.toISOString(),
});

export async function searchFoods(
  q: FoodSearchQuery,
  now = new Date(),
): Promise<FoodSearchResponse> {
  const key = searchCacheKey(q);
  const entry = await SearchCache.findOne({ key }).lean();
  // A page stored by older code may no longer match today's response shape: treat it as missing (refetch)
  // rather than serving it and failing the response schema.
  const stored = FoodSearchResponse.omit({ cached: true }).safeParse(entry?.payload).data;
  if (entry && stored && now.getTime() - entry.createdAt.getTime() < SEARCH_FRESH_MS)
    return { ...stored, cached: false };
  let raw: Raw;
  try {
    const body = await usdaGet("/foods/search", {
      query: q.q,
      pageSize: String(FOOD_SEARCH_PAGE_SIZE),
      pageNumber: String(q.page),
      ...(q.dataType ? { dataType: q.dataType } : {}),
    });
    raw = (typeof body === "object" && body !== null ? body : {}) as Raw;
  } catch (err) {
    if (!(err instanceof UsdaFailure)) throw err;
    // USDA rejected the query itself (400): no food matches it, and retrying will not help.
    if (err.kind === "not_found") return { ...emptyPage(q, now), cached: false };
    if (stored) return { ...stored, cached: true };
    throw unavailable();
  }
  const page: StoredSearch = {
    query: q.q,
    dataType: q.dataType ?? null,
    page: q.page,
    pageSize: FOOD_SEARCH_PAGE_SIZE,
    totalPages: Math.max(0, Math.trunc(num(raw.totalPages) ?? 0)),
    totalHits: Math.max(0, Math.trunc(num(raw.totalHits) ?? 0)),
    foods: records(raw.foods)
      .map((f) => summary(f, searchNutrients(f.foodNutrients)))
      .filter((f): f is FoodSummary => f !== null),
    fetchedAt: now.toISOString(),
  };
  await SearchCache.updateOne(
    { key },
    { $set: { payload: page, createdAt: now } },
    { upsert: true },
  ).catch(ignoreDuplicate);
  return { ...page, cached: false };
}

type StoredFood = {
  fdcId: number;
  description: string;
  dataType: string;
  brandOwner?: string | null;
  ingredientsText?: string | null;
  nutrients: FoodNutrient[];
  servingSizes: ServingSize[];
  fetchedAt: Date;
};

const toDetails = (f: StoredFood, cached: boolean): FoodDetails => ({
  fdcId: f.fdcId,
  description: f.description,
  dataType: f.dataType,
  brandOwner: f.brandOwner ?? null,
  ingredientsText: f.ingredientsText ?? null,
  nutrients: f.nutrients.map(({ nutrientId, name, unit, amountPer100g }) => ({
    nutrientId,
    name,
    unit,
    amountPer100g,
  })),
  servingSizes: f.servingSizes.map(({ label, grams }) => ({ label, grams })),
  cached,
  fetchedAt: f.fetchedAt.toISOString(),
});

const storedFoodFits = (doc: StoredFood): boolean => {
  try {
    return FoodDetails.safeParse(toDetails(doc, false)).success;
  } catch {
    return false;
  }
};

/** Details with cache-on-read: a stored food younger than 30 days never reaches USDA. */
export async function getFood(fdcId: number, now = new Date()): Promise<FoodDetails> {
  const doc = (await Food.findOne({ fdcId }).lean()) as StoredFood | null;
  // As for search: a stored food that no longer matches the response shape is refetched, not served.
  const stored = doc && storedFoodFits(doc) ? doc : null;
  if (stored && now.getTime() - stored.fetchedAt.getTime() < FOOD_REFRESH_MS)
    return toDetails(stored, false);
  let raw: Raw;
  try {
    const body = await usdaGet(`/food/${fdcId}`, {});
    raw = (typeof body === "object" && body !== null ? body : {}) as Raw;
  } catch (err) {
    if (!(err instanceof UsdaFailure)) throw err;
    // A food USDA no longer lists, or cannot serve now, is still shown from its stored copy:
    // log entries will point at it.
    if (stored) return toDetails(stored, true);
    if (err.kind === "not_found") throw new HttpError(404, "food_not_found");
    throw unavailable();
  }
  const base = summary(raw, detailNutrients(raw.foodNutrients));
  if (!base || base.fdcId !== fdcId) {
    console.error("[usda] /food/%d returned an unusable body", fdcId);
    if (stored) return toDetails(stored, true);
    throw unavailable();
  }
  const food: StoredFood = { ...base, servingSizes: servingSizes(raw), fetchedAt: now };
  await Food.updateOne({ fdcId }, { $set: food }, { upsert: true }).catch(ignoreDuplicate);
  return toDetails(food, false);
}
