"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { TOKEN_STATUSES, UNMATCHED_PAGE_SIZE } from "@healtheat/shared";
import type {
  AllergenView,
  RematchProgress,
  TokenStatus,
  UnmatchedListResponse,
  UnmatchedTokenView,
} from "@healtheat/shared";
import { RoleGate } from "../../role-gate";
import {
  UNMATCHED_MAX_PAGE,
  actOnUnmatched,
  allergenHref,
  listAllergens,
  listUnmatched,
  unmatchedHref,
} from "../../lib/curate";
import type { UnmatchedPageQuery } from "../../lib/curate";
import { foodHref } from "../../lib/foods";
import { formatDay } from "../../lib/home";
import { LoadError, useLoad } from "../../use-load";
import type { Load } from "../../use-load";
import { RematchControl } from "../rematch";
import styles from "../../manage.module.css";

const TAB_LABELS: Record<TokenStatus, string> = {
  new: "To review",
  mapped: "Mapped",
  ignored: "Ignored",
};

const EMPTY: Record<TokenStatus, string> = {
  new: "No ingredient phrases wait for review.",
  mapped: "No phrases have been mapped to an allergen yet.",
  ignored: "No phrases have been ignored.",
};

/**
 * The unmatched-ingredient queue (T22 web half; design doc, Pages table, phase 3): phrases from cached
 * foods' ingredient text that matched no allergen synonym, most foods first. A Curator maps a phrase to
 * an allergen, which adds it to that entry's synonyms and re-matches every cached food, or ignores it.
 */
export function UnmatchedQueue({ query }: { query: UnmatchedPageQuery }) {
  return (
    <RoleGate role="curator" title="Unmatched ingredients">
      {() => <Queue query={query} />}
    </RoleGate>
  );
}

function Queue({ query }: { query: UnmatchedPageQuery }) {
  const [list, retry] = useLoad((signal) => listUnmatched(query, signal), unmatchedHref(query));
  // The dictionary feeds each row's "Map to" choice; only the new and ignored phrases can be mapped, so
  // the Mapped tab does not load it.
  const [dictionary, retryDictionary] = useLoad(
    (signal) =>
      query.status === "mapped"
        ? Promise.resolve({ ok: true as const, data: { allergens: [] as AllergenView[] } })
        : listAllergens(signal),
    query.status,
  );
  // Phrases mapped or ignored on this page have left its list on the server, so the phrases after them
  // have moved up: paging on by offset would skip them. Once any row has acted, the pager reloads this
  // page instead of opening the next one.
  const [acted, setActed] = useState(0);
  const reload = () => {
    setActed(0);
    retry();
  };
  return (
    <main className={`${styles.wide} ${styles.view}`}>
      <h1>Unmatched ingredients</h1>
      <p className="lede">
        Ingredient phrases from cached USDA foods that matched no allergen synonym, the phrases in
        the most foods first. Mapping a phrase adds it to that allergen’s synonyms and re-matches
        every cached food; ignoring it only takes it off this list.
      </p>
      <div className={styles.actions}>
        <Link href="/curate/allergens">Allergen dictionary</Link>
      </div>
      <Tabs status={query.status} />
      {list.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading the queue…
        </p>
      ) : list.kind === "error" ? (
        <LoadError
          lead="Could not load the ingredient phrases."
          failure={list.failure}
          retry={retry}
          testId="unmatched-list-error"
        />
      ) : (
        <Results
          query={query}
          data={list.data}
          dictionary={dictionary}
          retryDictionary={retryDictionary}
          acted={acted}
          onActed={() => setActed((n) => n + 1)}
          onReload={reload}
        />
      )}
    </main>
  );
}

function Tabs({ status }: { status: TokenStatus }) {
  return (
    <nav className={styles.tabs} aria-label="Queue">
      {TOKEN_STATUSES.map((s) => (
        <Link
          key={s}
          href={unmatchedHref({ status: s, page: 1 })}
          aria-current={s === status ? "page" : undefined}
          data-testid={`tab-${s}`}
        >
          {TAB_LABELS[s]}
        </Link>
      ))}
    </nav>
  );
}

function Results({
  query,
  data,
  dictionary,
  retryDictionary,
  acted,
  onActed,
  onReload,
}: {
  query: UnmatchedPageQuery;
  data: UnmatchedListResponse;
  dictionary: Load<{ allergens: AllergenView[] }>;
  retryDictionary: () => void;
  acted: number;
  onActed: () => void;
  onReload: () => void;
}) {
  const pages = Math.min(
    UNMATCHED_MAX_PAGE,
    Math.max(1, Math.ceil(data.total / UNMATCHED_PAGE_SIZE)),
  );
  const mappable = query.status !== "mapped";
  // One heavy write (a map, or a Continue re-match) at a time on this page: each re-matches every cached
  // food for up to 60 seconds, and two passes over one allergen restart each other. A set of the rows
  // running one, so each row clears only its own entry.
  // Each running row's allergen name, so a waiting row can say which re-match it waits for.
  const [heavy, setHeavy] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Rows with a request in flight: reloading the page meanwhile would drop their answers.
  const [inFlight, setInFlight] = useState(0);
  return (
    <section aria-label={TAB_LABELS[query.status]}>
      <p className={styles.sub} data-testid="unmatched-total">
        {data.total} phrase{data.total === 1 ? "" : "s"}
      </p>
      {mappable && dictionary.kind === "error" ? (
        <LoadError
          failure={dictionary.failure}
          retry={retryDictionary}
          testId="unmatched-dictionary-error"
        />
      ) : null}
      {data.tokens.length === 0 ? (
        <p className={styles.status} data-testid="unmatched-empty">
          {data.total > 0 ? (
            <>
              Page {query.page} is past the end of this list.{" "}
              <Link href={unmatchedHref({ status: query.status, page: 1 })}>Go to page 1</Link>
            </>
          ) : (
            EMPTY[query.status]
          )}
        </p>
      ) : (
        <ul className={styles.queue}>
          {data.tokens.map((t) => (
            <TokenRow
              key={t.token}
              token={t}
              allergens={dictionary.kind === "done" ? dictionary.data.allergens : null}
              dictionaryFailed={dictionary.kind === "error"}
              heavyElsewhere={[...heavy].find(([k]) => k !== t.token)?.[1] ?? null}
              onHeavy={(name) =>
                setHeavy((h) => {
                  const next = new Map(h);
                  if (name === null) next.delete(t.token);
                  else next.set(t.token, name);
                  return next;
                })
              }
              onInFlight={(on) => setInFlight((n) => n + (on ? 1 : -1))}
              onActed={onActed}
            />
          ))}
        </ul>
      )}
      {query.status === "new" ? (
        <p className={styles.note}>
          Phrases are recorded when a food is matched, so a phrase that a later dictionary edit
          makes matchable stays here until someone reviews it.
        </p>
      ) : null}
      {pages > 1 || query.page > 1 || acted > 0 ? (
        <nav className={styles.pager} aria-label="Pages">
          {query.page > 1 ? (
            <Link href={unmatchedHref({ ...query, page: query.page - 1 })} rel="prev">
              ← Previous
            </Link>
          ) : null}
          <span data-testid="unmatched-page">
            Page {query.page} of {pages}
          </span>
          {acted > 0 || inFlight > 0 ? (
            // A request in flight may take its phrase off this page: paging on by offset would skip
            // the phrase after it, so the pager reloads this page once the requests are done.
            <button type="button" onClick={onReload} disabled={inFlight > 0}>
              Show the next phrases
            </button>
          ) : query.page < pages ? (
            <Link href={unmatchedHref({ ...query, page: query.page + 1 })} rel="next">
              Next →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

type Outcome =
  { kind: "mapped"; allergen: AllergenView; rematch: RematchProgress } | { kind: "ignored" };

function TokenRow({
  token,
  allergens,
  dictionaryFailed,
  heavyElsewhere,
  onHeavy,
  onInFlight,
  onActed,
}: {
  token: UnmatchedTokenView;
  /** The dictionary by display name, or null while it loads or after it failed. */
  allergens: AllergenView[] | null;
  dictionaryFailed: boolean;
  /** The allergen of another row's running map or Continue re-match, or null. */
  heavyElsewhere: string | null;
  /** This row's map or Continue re-match started (with its allergen's name) or ended (null). */
  onHeavy: (name: string | null) => void;
  /** A request of this row (map, ignore or Continue re-match) started or ended. */
  onInFlight: (on: boolean) => void;
  /** This row's phrase left its list (mapped or ignored). */
  onActed: () => void;
}) {
  const [allergenId, setAllergenId] = useState("");
  const [pending, setPending] = useState<"map" | "ignore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = useRef(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const id = `token-${token.token.replace(/[^a-z0-9]+/gi, "-")}`;
  // The pressed button is replaced by the outcome: focus moves there, not back to the top of the page.
  // Only while the Curator is still here: a map can answer up to a minute later, after they have moved
  // on to another row, and must not pull focus (and the scroll) back.
  const focusOutcome = useCallback((el: HTMLElement | null) => {
    const active = document.activeElement;
    // preventScroll: a late answer must not scroll the page back to this row either.
    if (el && (!active || active === document.body || rowRef.current?.contains(active)))
      el.focus({ preventScroll: true });
  }, []);

  async function act(input: { action: "map"; allergenId: string } | { action: "ignore" }) {
    if (busy.current) return;
    busy.current = true;
    setPending(input.action);
    setError(null);
    if (input.action === "map")
      onHeavy(allergens?.find((a) => a.id === input.allergenId)?.displayName ?? "allergen");
    onInFlight(true);
    try {
      const result = await actOnUnmatched(token.token, input);
      if (!result.ok) setError(result.failure.message);
      else {
        if (result.data.write)
          setOutcome({
            kind: "mapped",
            allergen: result.data.write.allergen,
            rematch: result.data.write.rematch,
          });
        else setOutcome({ kind: "ignored" });
        onActed();
      }
    } finally {
      busy.current = false;
      setPending(null);
      if (input.action === "map") onHeavy(null);
      onInFlight(false);
    }
  }

  function onMap(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!allergenId) {
      setError("Pick the allergen this phrase names.");
      return;
    }
    void act({ action: "map", allergenId });
  }

  return (
    <li
      ref={rowRef}
      className={styles.queueItem}
      data-testid="unmatched-row"
      data-token={token.token}
    >
      <div className={styles.queueHead}>
        <strong className={styles.queuePhrase}>{token.token}</strong>
        <span className={styles.muted}>
          in {token.count} cached food{token.count === 1 ? "" : "s"}
        </span>
        {token.status !== "new" && token.reviewedAt ? (
          <span className={styles.chip}>
            {token.status === "mapped" ? "Mapped" : "Ignored"} {formatDay(token.reviewedAt)}
          </span>
        ) : null}
      </div>
      {token.sampleFdcIds.length > 0 ? (
        <p className={styles.muted}>
          For example:{" "}
          {token.sampleFdcIds.map((fdcId, i) => (
            <span key={fdcId}>
              {i > 0 ? ", " : null}
              <Link href={foodHref(fdcId)}>food {fdcId}</Link>
            </span>
          ))}
        </p>
      ) : null}

      {outcome?.kind === "mapped" ? (
        <div role="status" data-testid="unmatched-mapped" tabIndex={-1} ref={focusOutcome}>
          <p className={styles.queueOutcome}>
            Added “{token.token}” to the synonyms of{" "}
            <Link href={allergenHref(outcome.allergen.key)}>{outcome.allergen.displayName}</Link>.
            {outcome.rematch.done ? " Every cached food has been re-matched." : null}
          </p>
          {outcome.rematch.done ? null : (
            <RematchControl
              id={outcome.allergen.id}
              name={outcome.allergen.displayName}
              initial={outcome.rematch}
              blocked={heavyElsewhere !== null}
              onPending={(on) => {
                onHeavy(on ? outcome.allergen.displayName : null);
                onInFlight(on);
              }}
            />
          )}
        </div>
      ) : outcome?.kind === "ignored" ? (
        <p
          className={styles.queueOutcome}
          role="status"
          data-testid="unmatched-ignored"
          tabIndex={-1}
          ref={focusOutcome}
        >
          Ignored. It is listed under Ignored, where it can still be mapped.
        </p>
      ) : token.status === "mapped" ? null : (
        <div className={styles.queueActions}>
          <form className={styles.mapForm} onSubmit={onMap} noValidate>
            <label htmlFor={`${id}-allergen`}>
              Allergen<span className={styles.srOnly}> for {token.token}</span>
            </label>
            <select
              id={`${id}-allergen`}
              value={allergenId}
              onChange={(e) => {
                setAllergenId(e.target.value);
                setError(null);
              }}
              disabled={!allergens || pending !== null}
            >
              <option value="">
                {allergens
                  ? "Choose an allergen"
                  : dictionaryFailed
                    ? "Allergens unavailable"
                    : "Loading allergens…"}
              </option>
              {(allergens ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="primary"
              disabled={!allergens || pending !== null || heavyElsewhere !== null}
              aria-describedby={heavyElsewhere !== null ? `${id}-waits` : undefined}
              aria-busy={pending === "map" || undefined}
              aria-label={`Map “${token.token}”`}
            >
              {pending === "map" ? "Mapping…" : "Map"}
            </button>
          </form>
          {heavyElsewhere !== null && pending === null ? (
            // Two re-match passes restart each other, so a second map waits; Ignore does not re-match.
            <p
              className={`${styles.note} ${styles.waits}`}
              id={`${id}-waits`}
              data-testid="unmatched-map-waits"
            >
              Map waits until the {heavyElsewhere} re-match finishes.
            </p>
          ) : null}
          {token.status === "new" ? (
            <button
              type="button"
              onClick={() => void act({ action: "ignore" })}
              disabled={pending !== null}
              aria-busy={pending === "ignore" || undefined}
              aria-label={`Ignore “${token.token}”`}
            >
              {pending === "ignore" ? "Ignoring…" : "Ignore"}
            </button>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="field-error" role="alert" data-testid="unmatched-row-error">
          {error}
        </p>
      ) : null}
    </li>
  );
}
