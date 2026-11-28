"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { MAX_LOG_GRAMS, MEALS, VISION_DAILY_LIMIT } from "@healtheat/shared";
import type {
  AllergenAlert,
  FoodSummary,
  LogEntryView,
  Meal,
  VisionItem,
  VisionMealInput,
} from "@healtheat/shared";
import { useAuth } from "../../auth-context";
import { logFood, searchFoods } from "../../lib/foods";
import { PhotoPrepError, prepareMealPhoto } from "../../lib/image";
import { MEAL_LABELS, formatLogDate, mealForHour, newRequestId } from "../../lib/logs";
import {
  CLIENT_TIMEOUT,
  analyseMeal,
  confidenceWord,
  prepProblem,
  visionProblem,
} from "../../lib/vision";
import type { PhotoProblem } from "../../lib/vision";
import { SWITCHED, confirmSession } from "../../profile/session";
import styles from "./day-log.module.css";

// Log by photo (T13; design doc, Photo pipeline): the member picks or takes a photo, the browser makes
// it small, POST /api/vision/meal proposes foods and grams, and the member confirms each one against a
// USDA food before it is logged. Only confirmed items are logged, as photo estimates at the analysis's
// confidence; the photo itself is never stored.

/** The browser's own limit while the photo is analysed; the server gives up at 60 s. */
const CLIENT_TIMEOUT_MS = 90_000;
/** USDA searches for the suggested items, run a few at a time. */
const SEARCH_CONCURRENCY = 3;
const MATCHES_SHOWN = 3;

type Matches =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; foods: FoodSummary[] };

type Item = {
  itemId: number;
  suggested: VisionItem;
  /** The search phrase, which the member can change and search again. */
  query: string;
  grams: string;
  include: boolean;
  matches: Matches;
  fdcId: number | null;
  /** One id per item (#51), kept until it is logged so a retry never logs it twice. */
  requestId?: string;
  logged: boolean;
  /** "Bananas, raw, 120 g": what was logged, shown once the item collapses. */
  loggedAs?: string;
  /** The log request for this item failed (not a check before sending). */
  failed?: boolean;
  error?: string;
};

type Phase =
  | { kind: "idle"; note?: string }
  | { kind: "preparing" }
  | { kind: "analysing" }
  /** `photo`: the prepared photo, kept for Try again; null when the photo itself was the problem. */
  | { kind: "error"; problem: PhotoProblem; photo: VisionMealInput | null }
  | { kind: "empty"; remaining: number }
  | {
      kind: "review";
      remaining: number;
      batchId?: string;
      note?: string;
      /** Avoided allergens of the items already logged, kept across a retry after a part-way failure. */
      alerts?: AllergenAlert[];
    }
  | { kind: "done"; logged: number; alerts: AllergenAlert[]; remaining: number };

function AvoidedAlert({ alerts }: { alerts: AllergenAlert[] }) {
  return (
    <p className="form-error" role="alert" data-testid="photo-alerts">
      Contains {alerts.map((a) => a.displayName).join(", ")}, which you avoid.
    </p>
  );
}

/** Shown when another tab changed the session: nothing here can go on until the page reloads. */
function ReloadPage() {
  return (
    <div className={styles.photoActions}>
      <button type="button" onClick={() => window.location.reload()} data-testid="photo-reload">
        Reload the page
      </button>
    </div>
  );
}

/** The suggested amount as the member sees it: whole grams, a decimal under 10 g, never 0. */
function gramsText(grams: number): string {
  return String(Math.max(0.1, grams < 10 ? Math.round(grams * 10) / 10 : Math.round(grams)));
}

function remainingText(remaining: number): string {
  return `${remaining} of ${VISION_DAILY_LIMIT} photos left today.`;
}

/** The grams typed for an item, or an error message. */
function readGrams(text: string): number | string {
  const grams = Number(text.trim());
  if (!text.trim() || !Number.isFinite(grams)) return "Enter the grams as a number.";
  if (grams <= 0) return "Enter more than 0 g.";
  if (grams > MAX_LOG_GRAMS) return `At most ${MAX_LOG_GRAMS.toLocaleString("en-US")} g.`;
  return grams;
}

export function PhotoConfirm({
  date,
  onLogged,
  onClose,
}: {
  date: string;
  onLogged: (entry: LogEntryView) => void;
  onClose: () => void;
}) {
  const { me, recheck } = useAuth();
  // The account this panel was opened for: the day log around it is that account's. When another tab
  // switches the session, recheck() moves `me` to the new account, so comparing with `me` would let the
  // next try go ahead as that account; every send and log is refused instead, until the page reloads.
  const [username] = useState(() => me?.user.username ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [items, setItems] = useState<Item[]>([]);
  const [meal, setMeal] = useState<Meal>(() => mealForHour(new Date().getHours()));
  const [logging, setLogging] = useState(false);
  const analysis = useRef<AbortController | null>(null);
  const searches = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const nextId = useRef(0);
  /** Each item's latest search: an older answer arriving later is dropped, and the first pass skips
   * an item the member already searched. */
  const searchSeq = useRef(new Map<number, number>());

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; // the log loop stops: nothing is posted with no panel to show it
      analysis.current?.abort();
      searches.current?.abort();
    };
  }, []);

  const patch = (itemId: number, change: Partial<Item>) =>
    setItems((list) => list.map((it) => (it.itemId === itemId ? { ...it, ...change } : it)));

  /** The top USDA matches for one item; the first is chosen unless the member picked another. */
  async function search(itemId: number, query: string, signal: AbortSignal) {
    const seq = (searchSeq.current.get(itemId) ?? 0) + 1;
    searchSeq.current.set(itemId, seq);
    patch(itemId, { matches: { kind: "loading" } });
    let result;
    try {
      result = await searchFoods({ q: query, page: 1 }, signal);
    } catch {
      return; // aborted: the panel moved on
    }
    if (searchSeq.current.get(itemId) !== seq) return; // a newer search for this item answers instead
    if (!result.ok) {
      patch(itemId, { matches: { kind: "error", message: result.failure.message }, fdcId: null });
      return;
    }
    const foods = result.data.foods.slice(0, MATCHES_SHOWN);
    setItems((list) =>
      list.map((it) => {
        if (it.itemId !== itemId) return it;
        const fdcId = foods.some((f) => f.fdcId === it.fdcId)
          ? it.fdcId
          : (foods[0]?.fdcId ?? null);
        // A different food is a different entry; the same one keeps its retry id (#51).
        const requestId = fdcId === it.fdcId ? it.requestId : undefined;
        return { ...it, matches: { kind: "ready", foods }, fdcId, requestId };
      }),
    );
  }

  async function searchAll(list: Item[]) {
    searches.current?.abort();
    const controller = new AbortController();
    searches.current = controller;
    const queue = [...list];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        if (controller.signal.aborted) return;
        if (searchSeq.current.has(it.itemId)) continue; // the member searched it already
        await search(it.itemId, it.query, controller.signal);
      }
    };
    await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));
  }

  async function analyse(input: VisionMealInput) {
    // Made before the session check, so Cancel or Close during the check stops the photo as well.
    const controller = new AbortController();
    analysis.current = controller;
    setPhase({ kind: "analysing" });
    const switched = await confirmSession(recheck, username);
    if (controller.signal.aborted) return; // cancelled or closed meanwhile: the photo is not sent
    if (switched) {
      if (analysis.current === controller) analysis.current = null;
      setPhase({
        kind: "error",
        problem: { message: switched, retry: true, another: false, search: false },
        photo: input,
      });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CLIENT_TIMEOUT_MS);
    let result;
    try {
      result = await analyseMeal(input, controller.signal);
    } catch {
      // Aborted: Cancel or Close (the panel already moved on), or the browser's own limit.
      if (timedOut) setPhase({ kind: "error", problem: CLIENT_TIMEOUT, photo: input });
      return;
    } finally {
      clearTimeout(timer);
      if (analysis.current === controller) analysis.current = null;
    }
    // request() reports an abort during the body read as a bad answer, not a throw: the same two cases.
    if (controller.signal.aborted) {
      if (timedOut) setPhase({ kind: "error", problem: CLIENT_TIMEOUT, photo: input });
      return;
    }
    if (!result.ok) {
      setPhase({ kind: "error", problem: visionProblem(result.failure), photo: input });
      return;
    }
    // Answered: from here on the photo is not kept anywhere.
    const { items: suggested, remainingToday } = result.data;
    if (suggested.length === 0) {
      setPhase({ kind: "empty", remaining: remainingToday });
      return;
    }
    const list: Item[] = suggested.map((s) => ({
      itemId: nextId.current++,
      suggested: s,
      query: s.query,
      grams: gramsText(s.grams),
      include: true,
      matches: { kind: "loading" },
      fdcId: null,
      logged: false,
    }));
    setItems(list);
    setPhase({ kind: "review", remaining: remainingToday, batchId: newRequestId() });
    void searchAll(list);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be chosen again after a failure
    if (!file) return;
    // Close while the photo is made smaller aborts this (the unmount cleanup), and nothing is sent.
    const preparing = new AbortController();
    analysis.current = preparing;
    setPhase({ kind: "preparing" });
    let input: VisionMealInput;
    try {
      input = await prepareMealPhoto(file);
    } catch (err) {
      if (preparing.signal.aborted) return;
      const kind = err instanceof PhotoPrepError ? err.kind : "unreadable";
      setPhase({ kind: "error", problem: prepProblem(kind), photo: null });
      return;
    }
    if (preparing.signal.aborted) return;
    await analyse(input);
  }

  function cancel() {
    analysis.current?.abort();
    analysis.current = null;
    setPhase({
      kind: "idle",
      note: `Cancelled. If the server had already started, the photo may still count toward today’s ${VISION_DAILY_LIMIT} photos.`,
    });
  }

  function startOver() {
    analysis.current?.abort();
    searches.current?.abort();
    setItems([]);
    setPhase({ kind: "idle" });
  }

  async function onLog(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current || phase.kind !== "review") return;
    const todo = items.filter((it) => it.include && !it.logged);
    if (todo.length === 0) return;
    // Check every item first: nothing is logged while any of them is wrong.
    let problems = 0;
    const checked = items.map((it) => {
      if (!it.include || it.logged) return it;
      const grams = readGrams(it.grams);
      const error =
        typeof grams === "string"
          ? grams
          : it.matches.kind === "loading"
            ? "Still searching USDA. Log again when the matches show."
            : it.fdcId === null
              ? "Choose the food it is, or search again."
              : undefined;
      if (error) problems += 1;
      return { ...it, error, failed: false };
    });
    setItems(checked);
    if (problems > 0) return;

    busy.current = true;
    setLogging(true);
    try {
      const switched = await confirmSession(recheck, username);
      if (switched) {
        setPhase({ ...phase, note: switched });
        return;
      }
      const alerts: AllergenAlert[] = [...(phase.alerts ?? [])];
      let logged = 0;
      let failed = 0;
      for (const it of checked) {
        if (!mounted.current) break; // the member left the page: the rest is not sent unseen
        if (!it.include || it.logged || it.fdcId === null) continue;
        const requestId = it.requestId ?? newRequestId();
        patch(it.itemId, { requestId, error: undefined, failed: false });
        const result = await logFood({
          fdcId: it.fdcId,
          grams: Number(it.grams.trim()),
          meal,
          date,
          source: "photo",
          confidence: it.suggested.confidence,
          ...(requestId ? { requestId } : {}),
          ...(phase.batchId ? { photoBatchId: phase.batchId } : {}),
        });
        if (result.ok) {
          logged += 1;
          for (const a of result.data.alerts)
            if (!alerts.some((b) => b.key === a.key)) alerts.push(a);
          const food =
            it.matches.kind === "ready"
              ? it.matches.foods.find((f) => f.fdcId === it.fdcId)?.description
              : undefined;
          patch(it.itemId, {
            logged: true,
            requestId: undefined,
            loggedAs: `${food ?? it.suggested.query}, ${it.grams.trim()} g`,
          });
          onLogged(result.data.entry);
          continue;
        }
        failed += 1;
        // A conflict means this id already logged something else: the next try gets a new one.
        patch(it.itemId, {
          error: result.failure.message,
          failed: true,
          ...(result.failure.error === "request_id_conflict" ? { requestId: undefined } : {}),
        });
        if (result.failure.status === 401) break; // signed out: the rest would fail the same way
      }
      if (failed === 0) {
        const before = items.filter((it) => it.logged).length;
        setPhase({ kind: "done", logged: before + logged, alerts, remaining: phase.remaining });
      } else {
        setPhase({
          ...phase,
          alerts,
          note: `${logged} logged, ${failed} not. Check the items marked below and log them again.`,
        });
      }
    } finally {
      busy.current = false;
      setLogging(false);
    }
  }

  const toLog = items.filter((it) => it.include && !it.logged).length;

  return (
    <section
      className={styles.photoPanel}
      aria-labelledby="photo-heading"
      data-testid="photo-panel"
    >
      <div className={styles.photoHeader}>
        <h2 id="photo-heading" className={styles.mealHeading}>
          Log by photo
        </h2>
        {/* Closing mid-log would post the rest unseen and lose their allergen alerts. */}
        <button type="button" onClick={onClose} disabled={logging} data-testid="photo-close">
          Close
        </button>
      </div>

      {/* After today's limit, or with photo logging unavailable, another photo is refused the same way. */}
      {phase.kind === "idle" ||
      phase.kind === "empty" ||
      (phase.kind === "error" && phase.problem.another) ? (
        <div className={styles.photoPick}>
          <label htmlFor="meal-photo" className="button-link">
            {phase.kind === "idle" ? "Choose or take a photo" : "Choose another photo"}
          </label>
          <input
            id="meal-photo"
            className={styles.photoInput}
            type="file"
            accept="image/*"
            onChange={(e) => void onFile(e)}
            data-testid="photo-input"
          />
          <p className="hint">
            The photo is sent to Anthropic to suggest the foods and grams, and is not stored (
            <Link href="/privacy#third-parties">privacy</Link>). You confirm every item before it is
            logged.
          </p>
          {phase.kind === "idle" && phase.note ? (
            <p className="hint" role="status">
              {phase.note}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase.kind === "preparing" ? (
        <p className="hint" role="status">
          Preparing the photo…
        </p>
      ) : null}

      {phase.kind === "analysing" ? (
        <div className={styles.photoWait} role="status" data-testid="photo-analysing">
          <p>Looking at the photo. This can take up to a minute.</p>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className={styles.problem} role="alert" data-testid="photo-error">
          <p>{phase.problem.message}</p>
          {phase.problem.message === SWITCHED ? <ReloadPage /> : null}
          <div className={styles.photoActions}>
            {phase.problem.retry && phase.photo && phase.problem.message !== SWITCHED ? (
              <button
                type="button"
                onClick={() => phase.photo && void analyse(phase.photo)}
                data-testid="photo-retry"
              >
                Try again
              </button>
            ) : null}
            {phase.problem.search ? <Link href={`/search?date=${date}`}>Log by search</Link> : null}
            {phase.problem.profile ? <Link href="/profile">Open your profile</Link> : null}
          </div>
        </div>
      ) : null}

      {phase.kind === "empty" ? (
        <div className={styles.problem} role="status" data-testid="photo-empty">
          <p>
            No foods were recognised in this photo. Try a clearer photo of the plate, or log the
            meal by search. {remainingText(phase.remaining)}
          </p>
          <Link href={`/search?date=${date}`}>Log by search</Link>
        </div>
      ) : null}

      {phase.kind === "review" ? (
        <form onSubmit={(e) => void onLog(e)} noValidate data-testid="photo-review">
          <p className="hint">
            Check each item: pick the food it is, fix the grams, or remove it. Nothing is logged
            until you press Log. {remainingText(phase.remaining)}
          </p>
          {phase.note ? (
            <p className="form-error" role="alert">
              {phase.note}
            </p>
          ) : null}
          {phase.note === SWITCHED ? <ReloadPage /> : null}
          {/* Named now: the member may close the panel instead of logging the rest. */}
          {phase.alerts?.length ? <AvoidedAlert alerts={phase.alerts} /> : null}
          <ul className={styles.photoItems}>
            {items.map((it) => (
              <PhotoItem
                key={it.itemId}
                item={it}
                disabled={logging}
                onChange={(change) =>
                  // Only a change to what is logged needs a new retry id (#51), as on Details.
                  patch(it.itemId, {
                    ...change,
                    ...("fdcId" in change || "grams" in change ? { requestId: undefined } : {}),
                  })
                }
                onSearch={(query) => {
                  const controller = searches.current ?? new AbortController();
                  searches.current = controller;
                  void search(it.itemId, query, controller.signal);
                }}
              />
            ))}
          </ul>
          <div className={styles.photoActions}>
            <label htmlFor="photo-meal">Meal</label>
            <select
              id="photo-meal"
              value={meal}
              disabled={logging}
              onChange={(e) => {
                setMeal(e.target.value as Meal);
                // A different meal is a different entry: new ids for what is not logged yet.
                setItems((list) => list.map((it) => ({ ...it, requestId: undefined })));
              }}
            >
              {MEALS.map((m) => (
                <option key={m} value={m}>
                  {MEAL_LABELS[m]}
                </option>
              ))}
            </select>
            <span className="hint">on {formatLogDate(date)}</span>
          </div>
          <div className={styles.photoActions}>
            <button
              type="submit"
              className="primary"
              disabled={logging || toLog === 0}
              aria-busy={logging || undefined}
              data-testid="photo-log"
            >
              {logging ? "Logging…" : toLog === 1 ? "Log 1 item" : `Log ${toLog} items`}
            </button>
            <button type="button" onClick={startOver} disabled={logging}>
              Start over
            </button>
          </div>
        </form>
      ) : null}

      {phase.kind === "done" ? (
        <div role="status" data-testid="photo-done">
          <p>
            Logged {phase.logged} {phase.logged === 1 ? "item" : "items"} from the photo to{" "}
            {formatLogDate(date)}, as estimates. {remainingText(phase.remaining)}
          </p>
          {phase.alerts.length > 0 ? <AvoidedAlert alerts={phase.alerts} /> : null}
          <div className={styles.photoActions}>
            <button type="button" onClick={startOver}>
              Log another photo
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PhotoItem({
  item,
  disabled,
  onChange,
  onSearch,
}: {
  item: Item;
  disabled: boolean;
  onChange: (change: Partial<Item>) => void;
  onSearch: (query: string) => void;
}) {
  const id = `photo-item-${item.itemId}`;
  if (item.logged)
    return (
      <li className={styles.photoItemCollapsed} data-testid="photo-item" data-state="logged">
        <span>{item.loggedAs ?? item.suggested.query}: logged.</span>
      </li>
    );
  if (!item.include)
    return (
      <li className={styles.photoItemCollapsed} data-testid="photo-item" data-state="removed">
        <span>{item.suggested.query} removed.</span>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => onChange({ include: true })}
          disabled={disabled}
        >
          Add back
        </button>
      </li>
    );
  return (
    <li
      className={item.error ? `${styles.photoItem} ${styles.photoItemError}` : styles.photoItem}
      data-testid="photo-item"
      data-state={item.failed ? "failed" : item.error ? "invalid" : "open"}
    >
      <p className={styles.photoItemHead}>
        <strong>{item.suggested.query}</strong>{" "}
        <span className="hint">({confidenceWord(item.suggested.confidence)})</span>
      </p>
      <div className={styles.photoActions}>
        <label htmlFor={`${id}-q`}>Search for</label>
        <input
          id={`${id}-q`}
          value={item.query}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => onChange({ query: e.target.value })}
        />
        <button
          type="button"
          disabled={disabled || !item.query.trim()}
          onClick={() => onSearch(item.query.trim())}
        >
          Search again
        </button>
      </div>
      <fieldset className={styles.matchList} disabled={disabled}>
        <legend>Which food is it?</legend>
        {item.matches.kind === "loading" ? <p className="hint">Searching USDA…</p> : null}
        {item.matches.kind === "error" ? (
          <p className="field-error">{item.matches.message}</p>
        ) : null}
        {item.matches.kind === "ready" && item.matches.foods.length === 0 ? (
          <p className="hint">
            No USDA food matches this search. Change the words and search again.
          </p>
        ) : null}
        {item.matches.kind === "ready"
          ? item.matches.foods.map((food) => (
              <label key={food.fdcId} className={styles.matchOption}>
                <input
                  type="radio"
                  name={`${id}-food`}
                  checked={item.fdcId === food.fdcId}
                  onChange={() => onChange({ fdcId: food.fdcId })}
                />
                <span>
                  {food.description}
                  {food.brandOwner ? <span className="hint"> · {food.brandOwner}</span> : null}
                </span>
              </label>
            ))
          : null}
      </fieldset>
      <div className={styles.photoActions}>
        <label htmlFor={`${id}-g`}>Grams</label>
        {/* Text, not type=number: an unreadable number would read as "" and be lost silently. */}
        <input
          id={`${id}-g`}
          className={styles.photoGrams}
          inputMode="decimal"
          value={item.grams}
          disabled={disabled}
          aria-invalid={item.error ? true : undefined}
          onChange={(e) => onChange({ grams: e.target.value, error: undefined })}
        />
        <button type="button" onClick={() => onChange({ include: false })} disabled={disabled}>
          Remove
        </button>
      </div>
      {item.error ? (
        <p className="field-error" role="alert">
          {item.failed ? `This item was not logged. ${item.error}` : item.error}
        </p>
      ) : null}
    </li>
  );
}
