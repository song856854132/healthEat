# Data provenance

Where the data vendored in `packages/shared` comes from, and under what terms.

## Allergen dictionary seed

- **File:** `packages/shared/src/allergens.seed.ts` (`ALLERGEN_SEED`).
- **Author:** the healthEat project (T11, 2026-11-14). Same license as the rest of this repository.
- **What it lists:** the 14 allergens that Regulation (EU) No 1169/2011, Annex II, requires food labels to declare, plus three sensitivities: lactose, histamine-rich foods and high-FODMAP foods. The Annex is legislation and is public. The synonyms, description keywords and exclude phrases are common English food words chosen for this project.
- **Histamine-rich keywords:** taken from the design doc's own list (aged cheese, parmesan, blue cheese, salami, cured ham, sauerkraut, kimchi, soy sauce, red wine, canned fish; D12), extended with similar foods. They are an estimate for the exposure meter, not medical advice.

### Open Food Facts: checked, not copied

The plan first said the seed would come from the Open Food Facts allergens taxonomy under "CC BY-SA". On 2026-11-14 we checked that claim, and it is wrong:

- The taxonomy (`taxonomies/allergens.txt` in `openfoodfacts/openfoodfacts-server`, last changed in commit `60a48362`, 2026-10-19) has no license of its own. It ships in a repository licensed AGPL-3.0.
- Open Food Facts publishes its data under the Open Database License (ODbL), which requires attribution and share-alike for derived databases.

The owner decided to write the seed instead of vendoring the taxonomy. We used the taxonomy only to check that our English entries cover the same 14 allergens. No lines were copied, so neither AGPL-3.0 nor ODbL applies to the seed. If you ever copy entries from the taxonomy, record the commit here, and add ODbL attribution ("(c) Open Food Facts contributors") to the About and Privacy pages.

## DRI tables

These are not vendored yet. Record their source, retrieval date, version and license here when they are added.
