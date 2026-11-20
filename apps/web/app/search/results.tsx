"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FOOD_SEARCH_MAX_PAGE } from "@healtheat/shared";
import type { FoodSearchResponse, FoodSummary } from "@healtheat/shared";
import { searchFoods, searchHref } from "../lib/foods";
import type { Failure, SearchCriteria } from "../lib/foods";
import { formatAmount, headline } from "../lib/nutrients";
import styles from "../foods.module.css";
import { CachedNote } from "../cached-note";

type State =
  | { kind: "loading" }
  | { kind: "error"; failure: Failure }
  | { kind: "done"; data: FoodSearchResponse };

export function SearchResults({ criteria }: { criteria: SearchCriteria }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    searchFoods(criteria, controller.signal).then(
      (r) =>
        setState(r.ok ? { kind: "done", data: r.data } : { kind: "error", failure: r.failure }),
      () => undefined, // aborted: a newer search replaced this one
    );
    return () => controller.abort();
  }, [criteria, attempt]);

  if (state.kind === "loading") {
    return (
      <p className={styles.status} role="status">
        Searching…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className={styles.error} role="alert" data-testid="search-error">
        <p>{state.failure.message}</p>
        <button
          type="button"
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const { data } = state;
  if (data.foods.length === 0) {
    return (
      <p className={styles.status} role="status" data-testid="search-empty">
        {data.page > 1 && data.totalHits > 0
          ? `No results on page ${data.page}. `
          : `No foods match “${data.query}”${data.dataType ? ` in ${data.dataType}` : ""}. `}
        {data.page > 1 && data.totalHits > 0 ? (
          <Link href={searchHref({ ...criteria, page: 1 })}>Back to page 1</Link>
        ) : (
          "Try a shorter or more general term."
        )}
      </p>
    );
  }

  return (
    <section className={styles.results} aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.resultsHeading} data-testid="search-summary">
        {data.totalHits.toLocaleString("en-US")} result{data.totalHits === 1 ? "" : "s"} for “
        {data.query}”{data.dataType ? ` in ${data.dataType}` : ""}
        {data.totalPages > 1
          ? ` · page ${data.page} of ${Math.min(data.totalPages, FOOD_SEARCH_MAX_PAGE)}`
          : ""}
      </h2>
      {data.cached ? <CachedNote fetchedAt={data.fetchedAt} /> : null}
      <ol className={styles.resultList} start={(data.page - 1) * data.pageSize + 1}>
        {data.foods.map((food) => (
          <ResultRow key={food.fdcId} food={food} />
        ))}
      </ol>
      <Pager criteria={criteria} totalPages={data.totalPages} />
    </section>
  );
}

function ResultRow({ food }: { food: FoodSummary }) {
  const h = headline(food.nutrients);
  return (
    <li className={styles.resultRow} data-testid="search-result">
      <div className={styles.resultMain}>
        <Link href={`/food/${food.fdcId}`} className={styles.resultTitle}>
          {food.description}
        </Link>
        <span className={styles.meta}>
          {[food.brandOwner, food.dataType].filter(Boolean).join(" · ")}
        </span>
      </div>
      <dl className={styles.headline} aria-label="Per 100 g">
        <div>
          <dt>Energy</dt>
          <dd>{h.energy ? `${formatAmount(h.energy.amountPer100g)} kcal` : "–"}</dd>
        </div>
        <div>
          <dt>Protein</dt>
          <dd>{h.protein ? `${formatAmount(h.protein.amountPer100g)} g` : "–"}</dd>
        </div>
        <div>
          <dt>Fat</dt>
          <dd>{h.fat ? `${formatAmount(h.fat.amountPer100g)} g` : "–"}</dd>
        </div>
        <div>
          <dt>Carbs</dt>
          <dd>{h.carbs ? `${formatAmount(h.carbs.amountPer100g)} g` : "–"}</dd>
        </div>
      </dl>
      <Link href={`/food/${food.fdcId}#log`} className={styles.logLink}>
        Log this
      </Link>
    </li>
  );
}

function Pager({
  criteria,
  totalPages: reported,
}: {
  criteria: SearchCriteria;
  totalPages: number;
}) {
  // USDA reports every page it has; the API serves only the first FOOD_SEARCH_MAX_PAGE of them.
  const totalPages = Math.min(reported, FOOD_SEARCH_MAX_PAGE);
  if (totalPages <= 1) return null;
  const { page } = criteria;
  return (
    <nav aria-label="Result pages" className={styles.pager}>
      {page > 1 ? (
        <Link href={searchHref({ ...criteria, page: page - 1 })} rel="prev">
          ← Previous
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <span>
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={searchHref({ ...criteria, page: page + 1 })} rel="next">
          Next →
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
