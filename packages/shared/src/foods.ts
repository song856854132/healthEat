import { z } from "zod";

/** USDA FoodData Central data types the search can be narrowed to (design doc, Pages: /search). */
export const FOOD_DATA_TYPES = ["Branded", "Foundation", "SR Legacy", "Survey (FNDDS)"] as const;
export const FoodDataType = z.enum(FOOD_DATA_TYPES);
export type FoodDataType = z.infer<typeof FoodDataType>;

/** Results per search page. Fixed so a page number always names the same slice (and cache entry). */
export const FOOD_SEARCH_PAGE_SIZE = 25;
/** Deepest page served: 200 pages of 25 is 5,000 results, far past anything a person reads. */
export const FOOD_SEARCH_MAX_PAGE = 200;

/** Query string of GET /api/foods/search. Whitespace is collapsed so equal searches share a cache entry. */
export const FoodSearchQuery = z.object({
  q: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1, "q is required").max(200)),
  dataType: FoodDataType.optional(),
  page: z.coerce.number().int().min(1).max(FOOD_SEARCH_MAX_PAGE).default(1),
});
export type FoodSearchQuery = z.infer<typeof FoodSearchQuery>;

/** One nutrient value per 100 g of the food (USDA reports every data type per 100 g). */
export const FoodNutrient = z.object({
  nutrientId: z.number().int(),
  name: z.string(),
  unit: z.string(),
  amountPer100g: z.number(),
});
export type FoodNutrient = z.infer<typeof FoodNutrient>;

/** A search hit: enough to render a result row and match allergens; headline nutrients only. */
export const FoodSummary = z.object({
  fdcId: z.number().int().positive(),
  description: z.string(),
  dataType: z.string(),
  brandOwner: z.string().nullable(),
  ingredientsText: z.string().nullable(),
  nutrients: z.array(FoodNutrient),
});
export type FoodSummary = z.infer<typeof FoodSummary>;

/**
 * Response of GET /api/foods/search. `cached` is true only when USDA failed (429 or 5xx) and an older
 * stored copy of this page is served instead; the web labels such a page "cached".
 */
export const FoodSearchResponse = z.object({
  query: z.string(),
  dataType: FoodDataType.nullable(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  totalHits: z.number().int().nonnegative(),
  foods: z.array(FoodSummary),
  cached: z.boolean(),
  fetchedAt: z.string().datetime(),
});
export type FoodSearchResponse = z.infer<typeof FoodSearchResponse>;

/** A portion the user can pick when logging: a label and its weight in grams. */
export const ServingSize = z.object({ label: z.string(), grams: z.number().positive() });
export type ServingSize = z.infer<typeof ServingSize>;

/** Response of GET /api/foods/:fdcId. `cached` has the same meaning as in FoodSearchResponse. */
export const FoodDetails = FoodSummary.extend({
  servingSizes: z.array(ServingSize),
  cached: z.boolean(),
  fetchedAt: z.string().datetime(),
});
export type FoodDetails = z.infer<typeof FoodDetails>;

/** Path parameter of GET /api/foods/:fdcId. */
export const FdcIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
