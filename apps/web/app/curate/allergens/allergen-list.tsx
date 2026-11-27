"use client";

import Link from "next/link";
import type { AllergenView } from "@healtheat/shared";
import { RoleGate } from "../../role-gate";
import { TIER_LABELS, allergenHref, listAllergens } from "../../lib/curate";
import { LoadError, useLoad } from "../../use-load";
import { RematchControl } from "../rematch";
import styles from "../../manage.module.css";

/** The whole dictionary, each entry linking to its editor, with "Continue re-match" where one is unfinished. */
export function AllergenList() {
  return (
    <RoleGate role="curator" title="Allergen dictionary">
      {() => <Dictionary />}
    </RoleGate>
  );
}

function Dictionary() {
  const [dictionary, retry] = useLoad(listAllergens);
  return (
    <main className={`${styles.wide} ${styles.view}`}>
      <h1>Allergen dictionary</h1>
      <p className="lede">
        Each entry’s synonyms are matched against the ingredient text of USDA foods, and its
        description keywords against food names. Saving an edit re-matches every cached food.
      </p>
      <div className={styles.actions}>
        <Link href="/curate/allergens/new" className="button-link">
          Add allergen
        </Link>
        <Link href="/curate/unmatched">Unmatched ingredients</Link>
      </div>
      {dictionary.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading the dictionary…
        </p>
      ) : dictionary.kind === "error" ? (
        <LoadError failure={dictionary.failure} retry={retry} testId="dictionary-error" />
      ) : (
        <Table allergens={dictionary.data.allergens} />
      )}
    </main>
  );
}

// A finished "Continue re-match" stays in its row saying "Re-match done": the table is not reloaded, so
// other rows' re-matches still running keep their place (and their buttons stay disabled).
function Table({ allergens }: { allergens: AllergenView[] }) {
  if (allergens.length === 0)
    return (
      <p className={styles.status}>
        The dictionary is empty. <Link href="/curate/allergens/new">Add the first allergen</Link>.
      </p>
    );
  return (
    <section aria-label="Allergens" data-testid="allergen-table">
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Allergen</th>
              <th scope="col">Tier</th>
              <th scope="col" className={styles.num}>
                Synonyms
              </th>
              <th scope="col" className={styles.num}>
                Keywords
              </th>
              <th scope="col" className={styles.num}>
                Excluded
              </th>
              <th scope="col">Source</th>
              <th scope="col">Re-match</th>
            </tr>
          </thead>
          <tbody>
            {allergens.map((a) => (
              <tr key={a.id} data-testid="allergen-row">
                <th scope="row">
                  <Link href={allergenHref(a.key)}>{a.displayName}</Link>
                  <div className={styles.muted}>
                    <code>{a.key}</code>
                  </div>
                </th>
                <td>{TIER_LABELS[a.tier]}</td>
                <td className={styles.num}>{a.synonyms.length}</td>
                <td className={styles.num}>{a.descriptionKeywords.length}</td>
                <td className={styles.num}>{a.excludePhrases.length}</td>
                <td>{a.source === "curator" ? "Curator edit" : "Seed"}</td>
                <td>
                  {a.rematchPending ? <RematchControl id={a.id} name={a.displayName} /> : "done"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
