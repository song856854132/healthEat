import type { Metadata } from "next";
import { readCriteria } from "../lib/foods";
import styles from "../foods.module.css";
import { SearchResults } from "./results";
import { SearchForm } from "./search-form";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q } = readCriteria(await searchParams);
  return { title: q ? `${q} · Search · healthEat` : "Search foods · healthEat" };
}

/**
 * /search?q=&dataType=&page= (design doc, Pages table: Search and Results). The URL is the whole
 * state: a search is a link that can be shared, reloaded or opened in another tab, and Back walks
 * through earlier searches.
 */
export default async function SearchPage({ searchParams }: Props) {
  const criteria = readCriteria(await searchParams);
  const key = `${criteria.q}|${criteria.dataType ?? ""}|${criteria.page}`;
  return (
    <main className={styles.wide}>
      <h1>Search foods</h1>
      {/* Keyed on the URL: Back and Forward must show that search's own terms, not the last typed. */}
      <SearchForm key={`form|${key}`} criteria={criteria} />
      <p className={styles.source}>
        Results come from USDA FoodData Central. Nutrients are per 100 g.
      </p>
      {criteria.q ? (
        // Keyed on the criteria so each search starts from a clean loading state.
        <SearchResults key={`results|${key}`} criteria={criteria} />
      ) : null}
    </main>
  );
}
