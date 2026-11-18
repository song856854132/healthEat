// Daily targets for the summary bands (T25): the Dietary Reference Intakes of the US National Academies
// (RDA where one exists, else AI) and the upper line (UL; for sodium the CDRR, 2,300 mg). Values from the
// NASEM DRI reports as tabulated by the NIH Office of Dietary Supplements; source, retrieval date and
// license are in packages/shared/data/PROVENANCE.md. ULs that apply only to supplements or fortificants
// (magnesium, vitamin E, niacin, folate, preformed vitamin A) are left out: food intake cannot be judged
// against them.

export const DRI_SEXES = ["female", "male"] as const;
export type DriSex = (typeof DRI_SEXES)[number];

/** Age bands of the DRI tables the summary uses; members under 14 use the 14-18 row. */
export const DRI_AGE_BANDS = ["14-18", "19-30", "31-50", "51-70", "71+"] as const;
export type DriAgeBand = (typeof DRI_AGE_BANDS)[number];

export type DriValue = { target: number; upper: number | null };
export type DriRow = Record<string, DriValue>;

type PerBand = Record<DriAgeBand, number>;
const all = (v: number): PerBand => ({
  "14-18": v,
  "19-30": v,
  "31-50": v,
  "51-70": v,
  "71+": v,
});
const bands = (teen: number, a19: number, a31: number, a51: number, a71: number): PerBand => ({
  "14-18": teen,
  "19-30": a19,
  "31-50": a31,
  "51-70": a51,
  "71+": a71,
});

/** Targets per nutrient key, sex and age band. */
const TARGETS: Record<string, Record<DriSex, PerBand>> = {
  protein: { female: all(46), male: bands(52, 56, 56, 56, 56) },
  fiber: { female: bands(26, 25, 25, 21, 21), male: bands(38, 38, 38, 30, 30) },
  vitaminA: { female: all(700), male: all(900) },
  vitaminC: { female: bands(65, 75, 75, 75, 75), male: bands(75, 90, 90, 90, 90) },
  vitaminD: { female: bands(15, 15, 15, 15, 20), male: bands(15, 15, 15, 15, 20) },
  vitaminE: { female: all(15), male: all(15) },
  vitaminK: { female: bands(75, 90, 90, 90, 90), male: bands(75, 120, 120, 120, 120) },
  thiamin: { female: bands(1.0, 1.1, 1.1, 1.1, 1.1), male: all(1.2) },
  riboflavin: { female: bands(1.0, 1.1, 1.1, 1.1, 1.1), male: all(1.3) },
  niacin: { female: all(14), male: all(16) },
  vitaminB6: { female: bands(1.2, 1.3, 1.3, 1.5, 1.5), male: bands(1.3, 1.3, 1.3, 1.7, 1.7) },
  folate: { female: all(400), male: all(400) },
  vitaminB12: { female: all(2.4), male: all(2.4) },
  calcium: {
    female: bands(1300, 1000, 1000, 1200, 1200),
    male: bands(1300, 1000, 1000, 1000, 1200),
  },
  iron: { female: bands(15, 18, 18, 8, 8), male: bands(11, 8, 8, 8, 8) },
  magnesium: { female: bands(360, 310, 320, 320, 320), male: bands(410, 400, 420, 420, 420) },
  potassium: {
    female: bands(2300, 2600, 2600, 2600, 2600),
    male: bands(3000, 3400, 3400, 3400, 3400),
  },
  sodium: { female: all(1500), male: all(1500) },
  zinc: { female: bands(9, 8, 8, 8, 8), male: bands(11, 11, 11, 11, 11) },
};

/** Upper lines per nutrient key and age band (the same for both sexes). */
const UPPER: Record<string, PerBand> = {
  vitaminC: bands(1800, 2000, 2000, 2000, 2000),
  vitaminD: all(100),
  vitaminB6: bands(80, 100, 100, 100, 100),
  calcium: bands(3000, 2500, 2500, 2000, 2000),
  iron: all(45),
  sodium: all(2300),
  zinc: bands(34, 40, 40, 40, 40),
};

/** The DRI row for one sex and age band, keyed by nutrient key. */
export function driRow(sex: DriSex, band: DriAgeBand): DriRow {
  const row: DriRow = {};
  for (const [key, bySex] of Object.entries(TARGETS))
    row[key] = { target: bySex[sex][band], upper: UPPER[key]?.[band] ?? null };
  return row;
}

/**
 * The adult reference row (eng review D9): for members without sex or age, each target is the higher of
 * the female and male values for ages 19-50 (so no need is understated) and each upper line the lower
 * (so no safe ceiling is overstated).
 */
export function referenceRow(): DriRow {
  const row: DriRow = {};
  const adult: DriAgeBand[] = ["19-30", "31-50"];
  for (const [key, bySex] of Object.entries(TARGETS)) {
    const targets = DRI_SEXES.flatMap((s) => adult.map((b) => bySex[s][b]));
    const uppers = adult.map((b) => UPPER[key]?.[b]).filter((u): u is number => u !== undefined);
    row[key] = {
      target: Math.max(...targets),
      upper: uppers.length > 0 ? Math.min(...uppers) : null,
    };
  }
  return row;
}

/** The age band for an age in whole years; under 14 uses the 14-18 row. */
export function ageBand(age: number): DriAgeBand {
  if (age < 19) return "14-18";
  if (age < 31) return "19-30";
  if (age < 51) return "31-50";
  if (age < 71) return "51-70";
  return "71+";
}
