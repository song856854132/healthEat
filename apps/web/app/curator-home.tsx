"use client";

import Link from "next/link";
import { useState } from "react";
import type { AllergenView } from "@healtheat/shared";
import { RematchControl } from "./curate/rematch";
import {
  TIER_LABELS,
  allergenHref,
  getCuratorProfile,
  listAllergens,
  unmatchedQueue,
} from "./lib/curate";
import { formatDay } from "./lib/home";
import { LoadError, useLoad } from "./use-load";
import styles from "./manage.module.css";

// Curator Home (T21; design doc, Pages table, Home row, and the Home wireframe's second screen):
// dictionary health. The allergens with their synonym counts, any re-match left unfinished, recent
// edits, and how many ingredient phrases wait in the unmatched queue. A Curator sees dictionary data and
// aggregate counts only, never a member's log.

/** The first few phrases of a list, for a table cell. */
function preview(phrases: string[], n = 4): string {
  if (phrases.length === 0) return "none";
  return phrases.length <= n
    ? phrases.join(", ")
    : `${phrases.slice(0, n).join(", ")}, +${phrases.length - n} more`;
}

export function CuratorHome() {
  const [dictionary, retry] = useLoad(listAllergens);
  return (
    <div className={styles.view} data-testid="curator-home">
      <p className="lede">
        The allergen dictionary turns USDA ingredient text into the alerts and exposure counts
        members see. Saving an edit re-matches the cached foods in the same request.
      </p>
      {dictionary.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading the dictionary…
        </p>
      ) : dictionary.kind === "error" ? (
        <LoadError failure={dictionary.failure} retry={retry} testId="dictionary-error" />
      ) : (
        <Dictionary allergens={dictionary.data.allergens} />
      )}
      <Activity />
    </div>
  );
}

function Dictionary({ allergens }: { allergens: AllergenView[] }) {
  // Re-matches finished from this page. The table is not reloaded, so a row whose re-match is still
  // running keeps its place, and a finished one says "Re-match done".
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set());
  const synonyms = allergens.reduce((n, a) => n + a.synonyms.length, 0);
  const pending = allergens.filter((a) => a.rematchPending && !finished.has(a.id));
  return (
    <>
      <section aria-labelledby="dictionary-heading" data-testid="curator-dictionary">
        <h2 id="dictionary-heading">
          Allergen dictionary ({allergens.length} allergen{allergens.length === 1 ? "" : "s"} ·{" "}
          {synonyms} synonym{synonyms === 1 ? "" : "s"})
        </h2>
        <p className={styles.sub}>
          Ingredient text from USDA branded foods is matched against these synonyms; foods without
          ingredient text, and every food for sensitivities, are matched on description keywords.
        </p>
        <p data-testid="rematch-summary">
          {pending.length === 0
            ? "No re-match in progress: every entry has been matched against the cached foods."
            : `${pending.length} re-match${pending.length === 1 ? " is" : "es are"} unfinished. Continue ${pending.length === 1 ? "it" : "them"} below.`}
        </p>
        {allergens.length === 0 ? (
          <p className={styles.muted}>The dictionary is empty.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Allergen</th>
                  <th scope="col">Tier</th>
                  <th scope="col" className={styles.num}>
                    Synonyms
                  </th>
                  <th scope="col">Ingredient text</th>
                  <th scope="col">Re-match</th>
                </tr>
              </thead>
              <tbody>
                {allergens.map((a) => (
                  <tr key={a.id} data-testid="dictionary-row">
                    <th scope="row">
                      <Link href={allergenHref(a.key)}>{a.displayName}</Link>
                      {a.source === "curator" ? (
                        <>
                          {" "}
                          <span className={styles.chip} title="Changed by a Curator since the seed">
                            edited
                          </span>
                        </>
                      ) : null}
                    </th>
                    <td>{TIER_LABELS[a.tier]}</td>
                    <td className={styles.num}>{a.synonyms.length}</td>
                    <td className={styles.phrases}>{preview(a.synonyms)}</td>
                    <td>
                      {a.rematchPending ? (
                        <RematchControl
                          id={a.id}
                          name={a.displayName}
                          onDone={() => setFinished((f) => new Set(f).add(a.id))}
                        />
                      ) : (
                        "done"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.actions}>
          <Link href="/curate/allergens" className="button-link">
            Open the dictionary
          </Link>
          <Link href="/curate/allergens/new">Add allergen</Link>
        </div>
        <p className={styles.note}>
          Curators see dictionary data and aggregate match counts only, never a member’s log. Edits
          are attributed to you and counted on your Curator profile.
        </p>
      </section>
      <RecentEdits allergens={allergens} />
    </>
  );
}

/** Entries a Curator changed since the seed: the dictionary's own record of recent edits. */
function RecentEdits({ allergens }: { allergens: AllergenView[] }) {
  const edited = allergens.filter((a) => a.source === "curator");
  return (
    <section aria-labelledby="edits-heading" data-testid="curator-edits">
      <h2 id="edits-heading">Edited by Curators</h2>
      {edited.length === 0 ? (
        <p className={styles.muted}>Every entry is still as the seed wrote it.</p>
      ) : (
        <ul>
          {edited.map((a) => (
            <li key={a.id}>
              <Link href={allergenHref(a.key)}>{a.displayName}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Curator's own counters and the unmatched queue's size, each loaded on its own. */
function Activity() {
  const [profile, retryProfile] = useLoad(getCuratorProfile);
  const [queue, retryQueue] = useLoad(unmatchedQueue);
  return (
    <section aria-labelledby="activity-heading" data-testid="curator-activity">
      <h2 id="activity-heading">Your work</h2>
      <ul className={styles.tiles}>
        <li className={styles.tile} data-testid="tile-edits">
          {profile.kind === "done" ? (
            <>
              <strong>{profile.data.editsCount}</strong>{" "}
              <span>
                dictionary edit{profile.data.editsCount === 1 ? "" : "s"} by you
                {profile.data.lastEditAt
                  ? `, the last on ${formatDay(profile.data.lastEditAt)}`
                  : ""}
              </span>
            </>
          ) : profile.kind === "error" ? (
            <LoadError failure={profile.failure} retry={retryProfile} testId="edits-error" />
          ) : (
            <span role="status">Loading…</span>
          )}
        </li>
        <li className={styles.tile} data-testid="tile-unmatched">
          {queue.kind === "done" ? (
            <>
              <strong>{queue.data.total}</strong>{" "}
              <span>
                ingredient phrase
                {queue.data.total === 1
                  ? " matched no synonym and waits"
                  : "s matched no synonym and wait"}{" "}
                for review
              </span>{" "}
              <Link href="/curate/unmatched" data-testid="unmatched-link">
                Review them
              </Link>
            </>
          ) : queue.kind === "error" ? (
            <LoadError failure={queue.failure} retry={retryQueue} testId="unmatched-error" />
          ) : (
            <span role="status">Loading…</span>
          )}
        </li>
      </ul>
    </section>
  );
}
