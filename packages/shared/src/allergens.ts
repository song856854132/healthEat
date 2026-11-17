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

/** Body of POST /api/allergens (curator): a new dictionary entry. */
export const AllergenCreateInput = AllergenEntry;
export type AllergenCreateInput = z.infer<typeof AllergenCreateInput>;

/**
 * Body of PUT /api/allergens/:id (curator): every editable field, replacing the stored ones. The key is
 * the entry's stable identifier in URLs, so it cannot change: a body that sends one is refused (400).
 */
export const AllergenUpdateInput = AllergenEntry.omit({ key: true }).strict();
export type AllergenUpdateInput = z.infer<typeof AllergenUpdateInput>;

/** An allergen as GET /api/allergens returns it. */
export const AllergenView = AllergenEntry.extend({
  id: z.string(),
  source: AllergenSource,
  /**
   * True while a re-match after an edit has foods left to process: the Curator page offers "Continue
   * re-match" (POST /api/curate/allergens/:id/rematch) until it is false.
   */
  rematchPending: z.boolean(),
});
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

/**
 * Progress of the re-match after a dictionary write (design doc, Re-match on dictionary change). The
 * write's own request runs it for up to 60 seconds; `done: false` (HTTP 202) means foods are left and
 * POST /api/curate/allergens/:id/rematch continues it.
 */
export const RematchProgress = z.object({
  done: z.boolean(),
  processed: z.number().int().min(0),
  remaining: z.number().int().min(0),
});
export type RematchProgress = z.infer<typeof RematchProgress>;

/** Response of POST and PUT /api/allergens: the stored entry and how far its re-match got. */
export const AllergenWriteResponse = z.object({
  allergen: AllergenView,
  rematch: RematchProgress,
});
export type AllergenWriteResponse = z.infer<typeof AllergenWriteResponse>;
