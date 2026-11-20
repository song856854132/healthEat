"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { FOOD_DATA_TYPES } from "@healtheat/shared";
import { readCriteria, searchHref } from "../lib/foods";
import type { SearchCriteria } from "../lib/foods";
import styles from "../foods.module.css";

/**
 * The search form. It is a plain GET form, so it works before hydration; once hydrated, submitting
 * builds the URL with searchHref, which drops an empty data type and page 1 (`/search?q=cheddar`, not
 * `/search?q=cheddar&dataType=`). A new search always starts at page 1.
 */
export function SearchForm({ criteria }: { criteria: SearchCriteria }) {
  const router = useRouter();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const data = new FormData(e.currentTarget);
    const next = readCriteria({
      q: String(data.get("q") ?? ""),
      dataType: String(data.get("dataType") ?? ""),
    });
    e.preventDefault();
    if (next.q) router.push(searchHref(next)); // whitespace alone passes `required`: ignore it
  }

  return (
    <form
      action="/search"
      method="get"
      role="search"
      className={styles.searchForm}
      onSubmit={onSubmit}
    >
      <label htmlFor="search-q" className={styles.srOnly}>
        Food
      </label>
      <input
        id="search-q"
        name="q"
        type="search"
        defaultValue={criteria.q}
        placeholder="cheddar, apple, oat milk…"
        maxLength={200}
        required
        autoFocus={!criteria.q}
      />
      <label htmlFor="search-type" className={styles.srOnly}>
        Data type
      </label>
      <select id="search-type" name="dataType" defaultValue={criteria.dataType ?? ""}>
        <option value="">All data types</option>
        {FOOD_DATA_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="submit">Search</button>
    </form>
  );
}
