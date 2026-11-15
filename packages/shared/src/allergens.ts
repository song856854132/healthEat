import { z } from "zod";

/**
 * How an allergen is treated by default (design doc, Data model: Allergen; D12). `allergy`: any trace is
 * a hard alert. `sensitivity`: hits add up in the weekly exposure meter. `both`: either, by the member's
 * choice; it is matched like an allergy. The member's own mode (avoid or track) arrives with UserAllergen.
 */
export const ALLERGEN_TIERS = ["allergy", "sensitivity", "both"] as const;
export const AllergenTier = z.enum(ALLERGEN_TIERS);
export type AllergenTier = z.infer<typeof AllergenTier>;

/** Who wrote a dictionary entry: the project's own seed, or a Curator edit. */
export const ALLERGEN_SOURCES = ["seed", "curator"] as const;
export const AllergenSource = z.enum(ALLERGEN_SOURCES);
export type AllergenSource = z.infer<typeof AllergenSource>;

/**
 * Where a food matched an allergen. `ingredient`: a synonym in the label's ingredient text.
 * `description`: a description keyword in the food's name, for foods without ingredient text and, for
 * sensitivity-tier allergens, for every food (D12). Description matches are estimates.
 */
export const MATCH_KINDS = ["ingredient", "description"] as const;
export const MatchKind = z.enum(MATCH_KINDS);
export type MatchKind = z.infer<typeof MatchKind>;

/** Shown next to every description match, in the exposure meter and on food pages (D12). */
export const FOOD_CATEGORY_ESTIMATE_LABEL = "food-category estimate";

/** Stable identifier of an allergen in URLs (`/curate/allergens/[key]`): lowercase words and hyphens. */
export const AllergenKey = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens")
  .max(40);

const phrase = z.string().trim().min(1).max(80);

/** One dictionary entry as the seed defines it, and the editable fields of a stored Allergen. */
export const AllergenEntry = z.object({
  key: AllergenKey,
  displayName: z.string().trim().min(1).max(60),
  tier: AllergenTier,
  /** Ingredient words and phrases, matched whole-word inside one ingredient of the label. */
  synonyms: z.array(phrase).max(200),
  /** Words and phrases matched whole-word in the food's description (D12). */
  descriptionKeywords: z.array(phrase).max(200),
  /** Phrases that contain a synonym but are not this allergen ("cocoa butter" for milk). */
  excludePhrases: z.array(phrase).max(200),
});
export type AllergenEntry = z.infer<typeof AllergenEntry>;

/** An allergen as GET /api/allergens returns it. */
export const AllergenView = AllergenEntry.extend({ id: z.string(), source: AllergenSource });
export type AllergenView = z.infer<typeof AllergenView>;

/** Response of GET /api/allergens: the whole dictionary, ordered by display name. */
export const AllergenListResponse = z.object({ allergens: z.array(AllergenView) });
export type AllergenListResponse = z.infer<typeof AllergenListResponse>;

/** An allergen detected in one food, as GET /api/foods/:fdcId returns it. */
export const FoodAllergenMatch = z.object({
  key: AllergenKey,
  displayName: z.string(),
  tier: AllergenTier,
  matchKind: MatchKind,
  /** The synonym or keyword that matched, as written in the dictionary. */
  matchedSynonym: z.string(),
});
export type FoodAllergenMatch = z.infer<typeof FoodAllergenMatch>;
