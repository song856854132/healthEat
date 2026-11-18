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

- **File:** `packages/shared/src/dri.ts` (`driRow`, `referenceRow`), used by the weekly summary (T25).
- **Source:** the Dietary Reference Intakes of the National Academies of Sciences, Engineering, and Medicine (NASEM), as tabulated per nutrient in the NIH Office of Dietary Supplements fact sheets (https://ods.od.nih.gov/factsheets/list-all/) and the NASEM DRI summary tables. Values transcribed by the project on 2026-11-18. Sodium uses the 2019 Chronic Disease Risk Reduction intake (2,300 mg) as its upper line; potassium the 2019 AIs.
- **License:** the DRI values are facts published by US government and National Academies reports; the table layout and selection are the project's, under this repository's license. OpenNutriTracker's tables (named in the design doc as a port source) were not used, so their license does not apply.
- **Choices:** RDA where one exists, else AI. ULs that apply only to supplements or fortificants (magnesium, vitamin E, niacin, folate, preformed vitamin A) are omitted, because a food log cannot be judged against them. The adult reference row (for members without sex or age) takes the higher female/male target and the lower upper line for ages 19-50.
- **Folate:** the target is in µg DFE (USDA nutrient 1190). A food that reports only total folate (1177) is counted 1:1 against it, which understates fortified foods, since 1 µg of folic acid is 1.7 µg DFE.
