"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FOOD_CATEGORY_ESTIMATE_LABEL } from "@healtheat/shared";
import type { FoodAllergenMatch, FoodDetails, ServingSize } from "@healtheat/shared";
import { CachedNote } from "../../cached-note";
import { getFood } from "../../lib/foods";
import type { Failure } from "../../lib/foods";
import { formatAmount, headlineFirst, scaled } from "../../lib/nutrients";
import styles from "../../foods.module.css";
import { LogForm } from "./log-form";

type State =
  { kind: "loading" } | { kind: "error"; failure: Failure } | { kind: "done"; food: FoodDetails };

const PER_100G: ServingSize = { label: "100 g", grams: 100 };

export function FoodView({ fdcId }: { fdcId: number }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getFood(fdcId, controller.signal).then(
      (r) =>
        setState(r.ok ? { kind: "done", food: r.data } : { kind: "error", failure: r.failure }),
      () => undefined, // aborted: the page moved on
    );
    return () => controller.abort();
  }, [fdcId, attempt]);

  useEffect(() => {
    if (state.kind === "done") document.title = `${state.food.description} · healthEat`;
  }, [state]);

  if (state.kind === "loading") {
    return (
      <p className={styles.status} role="status">
        Loading food {fdcId}…
      </p>
    );
  }
  if (state.kind === "error") {
    const missing = state.failure.error === "food_not_found";
    return (
      <div className={styles.error} role="alert" data-testid="food-error">
        <h1>{missing ? "Food not found" : "Could not load this food"}</h1>
        <p>{state.failure.message}</p>
        {missing ? (
          <p>
            <Link href="/search">Search foods</Link>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  return <FoodDetailsView food={state.food} />;
}

function FoodDetailsView({ food }: { food: FoodDetails }) {
  const portions = [PER_100G, ...food.servingSizes.filter((s) => s.label !== PER_100G.label)];
  // The label serving of a branded food is the usual portion; otherwise start from 100 g.
  const [portion, setPortion] = useState<ServingSize>(food.servingSizes[0] ?? PER_100G);
  const [custom, setCustom] = useState("");
  const customGrams = Number(custom);
  // 0 while "Other amount" has no usable number yet: the table shows per 100 g only, and the log
  // form asks for an amount.
  const grams =
    portion.label !== CUSTOM
      ? portion.grams
      : Number.isFinite(customGrams) && customGrams > 0
        ? customGrams
        : 0;

  return (
    <article className={styles.food}>
      <p className={styles.crumb}>
        <Link href="/search">← Search foods</Link>
      </p>
      <h1 data-testid="food-title">{food.description}</h1>
      <p className={styles.meta}>
        {[food.brandOwner, food.dataType, `FDC ${food.fdcId}`].filter(Boolean).join(" · ")}
      </p>
      {food.cached ? <CachedNote fetchedAt={food.fetchedAt} /> : null}

      <section aria-labelledby="allergens-heading">
        <h2 id="allergens-heading">Allergens detected</h2>
        <Allergens matches={food.allergens} />
      </section>

      <section aria-labelledby="portion-heading">
        <h2 id="portion-heading">Log this food</h2>
        <div className={styles.portionRow}>
          <label htmlFor="portion">Portion</label>
          <select
            id="portion"
            value={portion.label}
            onChange={(e) => {
              const label = e.target.value;
              setPortion(
                label === CUSTOM
                  ? { label: CUSTOM, grams: 0 }
                  : (portions.find((p) => p.label === label) ?? PER_100G),
              );
            }}
          >
            {portions.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Other amount…</option>
          </select>
          {portion.label === CUSTOM ? (
            <>
              <label htmlFor="portion-grams" className={styles.srOnly}>
                Grams
              </label>
              <input
                id="portion-grams"
                type="number"
                inputMode="decimal"
                min="0.1"
                step="any"
                placeholder="grams"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className={styles.gramsInput}
              />
              <span>g</span>
            </>
          ) : null}
        </div>
        <LogForm fdcId={food.fdcId} grams={grams} />
      </section>

      <section aria-labelledby="nutrients-heading">
        <h2 id="nutrients-heading">Nutrients</h2>
        <Nutrients food={food} grams={grams} />
      </section>

      {food.ingredientsText ? (
        <section aria-labelledby="ingredients-heading">
          <h2 id="ingredients-heading">Ingredients</h2>
          <p data-testid="ingredients">{food.ingredientsText}</p>
        </section>
      ) : null}

      <p className={styles.source}>
        Source: USDA FoodData Central, FDC ID {food.fdcId}. Allergens are detected by healthEat from
        the ingredient list and the food&apos;s name; check the package label before relying on
        them.
      </p>
    </article>
  );
}

const CUSTOM = "__custom__";

const TIER_LABELS: Record<FoodAllergenMatch["tier"], string> = {
  allergy: "allergy",
  sensitivity: "sensitivity",
  both: "allergy and sensitivity",
};

function Allergens({ matches }: { matches: readonly FoodAllergenMatch[] }) {
  if (matches.length === 0) {
    return (
      <p data-testid="allergens-none">
        None of the allergens in the healthEat dictionary were found in this food.
      </p>
    );
  }
  return (
    <ul className={styles.chips} data-testid="allergens">
      {matches.map((m) => (
        <li key={m.key} className={styles.chip} data-tier={m.tier}>
          <span className={styles.chipName}>{m.displayName}</span>
          <span className={styles.chipTier}>{TIER_LABELS[m.tier]}</span>
          {m.matchKind === "description" ? (
            <span className={styles.chipEstimate}>{FOOD_CATEGORY_ESTIMATE_LABEL}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Nutrients({ food, grams }: { food: FoodDetails; grams: number }) {
  if (food.nutrients.length === 0) return <p>USDA lists no nutrient values for this food.</p>;
  const showPortion = grams > 0 && grams !== 100;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.nutrients} data-testid="nutrients">
        <thead>
          <tr>
            <th scope="col">Nutrient</th>
            <th scope="col">Per 100 g</th>
            {showPortion ? <th scope="col">Per {formatAmount(grams)} g</th> : null}
          </tr>
        </thead>
        <tbody>
          {headlineFirst(food.nutrients).map((n) => (
            <tr key={`${n.nutrientId}-${n.unit}`}>
              <th scope="row">{n.name}</th>
              <td>
                {formatAmount(n.amountPer100g)} {n.unit}
              </td>
              {showPortion ? (
                <td>
                  {formatAmount(scaled(n.amountPer100g, grams))} {n.unit}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
