import type { NutrientBand, SummaryResponse } from "@healtheat/shared";

// The one clearly labelled "example week" band on anonymous Home (design doc, Pages table). Made-up
// numbers in the summary's own shapes, so the sample is drawn by the same component as a member's
// week: 4 of 7 days logged, one of them mostly photo-estimated, and every band class on show,
// including the vitamin E gap from the demo script (41% of a 15 mg target).

const band = (
  key: string,
  name: string,
  unit: string,
  target: number,
  upper: number | null,
  coverage: number | null,
  status: NutrientBand["status"],
  dataCoverage = 1,
): NutrientBand => ({
  key,
  name,
  unit,
  target,
  upper,
  intakePerDay: coverage === null ? null : coverage * target,
  coverage,
  dataCoverage,
  status,
});

const day = (date: string, confidence: number | null): SummaryResponse["days"][number] => ({
  date,
  logged: confidence !== null,
  confidence,
});

export const EXAMPLE_WEEK: {
  bands: NutrientBand[];
  days: SummaryResponse["days"];
  loggedDays: number;
} = {
  days: [
    day("2026-11-09", 1),
    day("2026-11-10", null),
    day("2026-11-11", 0.3),
    day("2026-11-12", 0.9),
    day("2026-11-13", null),
    day("2026-11-14", 1),
    day("2026-11-15", null),
  ],
  loggedDays: 4,
  bands: [
    band("vitaminE", "Vitamin E", "mg", 15, null, 0.41, "low"),
    band("fiber", "Fiber", "g", 25, null, 0.62, "low"),
    band("magnesium", "Magnesium", "mg", 320, null, 0.78, "ok"),
    band("iron", "Iron", "mg", 18, 45, 1.04, "ok"),
    band("protein", "Protein", "g", 46, null, 1.18, "ok"),
    band("sodium", "Sodium", "mg", 1500, 2300, 1.63, "high"),
    band("vitaminD", "Vitamin D", "µg", 15, 100, null, "insufficient", 0.3),
  ],
};
