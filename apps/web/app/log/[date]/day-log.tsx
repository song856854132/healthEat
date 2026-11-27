"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LogEntryUpdateInput, MAX_LOG_GRAMS, MEALS } from "@healtheat/shared";
import type { LogEntryView, Meal } from "@healtheat/shared";
import { useAuth } from "../../auth-context";
import {
  MEAL_LABELS,
  addDays,
  deleteLog,
  formatGrams,
  formatLogDate,
  listLogs,
  memberTimeZone,
  todayIn,
  updateLog,
} from "../../lib/logs";
import { foodHref } from "../../lib/foods";
import { PhotoConfirm } from "./photo-confirm";
import styles from "./day-log.module.css";

type Load =
  /** `reloading`: the day was shown before, so the photo panel stays open through the reload. */
  | { kind: "loading"; reloading?: boolean }
  | { kind: "error"; message: string }
  | { kind: "future"; today: string }
  | { kind: "ready"; today: string; entries: LogEntryView[] };

/**
 * One day of the member's log: entries by meal, each editable (grams and meal) and deletable, with
 * previous/next day, a date picker, "Add food", which carries the date through search to Details
 * so a past day can be backfilled, and "Log by photo" (T13), which opens the photo panel (also opened
 * by ?photo=1, Home's link). "Today" is the member's time zone's, as on the API.
 */
export function DayLog({ date, photo = false }: { date: string; photo?: boolean }) {
  const { me } = useAuth();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [photoOpen, setPhotoOpen] = useState(photo);
  const [attempt, setAttempt] = useState(0);
  const signedIn = Boolean(me);

  useEffect(() => {
    if (me === null) router.replace("/login");
  }, [me, router]);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    void (async () => {
      const tz = await memberTimeZone(controller.signal);
      if (!tz.ok) return setLoad({ kind: "error", message: tz.failure.message });
      const today = todayIn(tz.data);
      if (date > today) return setLoad({ kind: "future", today });
      const logs = await listLogs({ from: date, to: date }, controller.signal);
      setLoad(
        logs.ok
          ? { kind: "ready", today, entries: logs.data.entries }
          : { kind: "error", message: logs.failure.message },
      );
    })().catch(() => {
      // Aborted: the date changed or the page closed. Anything else (a time zone this browser does
      // not know) must not leave the page on "Loading…".
      if (!controller.signal.aborted) {
        setLoad({ kind: "error", message: "Could not work out today's date here. Try again." });
      }
    });
    return () => controller.abort();
  }, [signedIn, date, attempt]);

  if (!me) {
    return (
      <main>
        <h1>Day log</h1>
        <p className="hint">
          {me === null ? "Log in to see your day log. Taking you to the login page…" : "Loading…"}
        </p>
      </main>
    );
  }

  const today = load.kind === "ready" || load.kind === "future" ? load.today : undefined;
  const reload = () => {
    setLoad({ kind: "loading", reloading: true });
    setAttempt((n) => n + 1);
  };

  return (
    <main>
      <p className={styles.eyebrow}>Day log</p>
      <h1 data-testid="day-title">
        {formatLogDate(date)}
        {today === date ? <span className={styles.todayBadge}>Today</span> : null}
      </h1>
      <DayNav date={date} today={today} />

      {load.kind === "loading" ? (
        <p className="hint" role="status">
          Loading…
        </p>
      ) : null}
      {load.kind === "error" ? (
        <div role="alert" className={styles.problem}>
          <p>{load.message}</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {load.kind === "future" ? (
        <p className={styles.problem} data-testid="day-future">
          This day is after today, so nothing can be logged to it yet.{" "}
          <Link href={`/log/${load.today}`}>Go to today</Link>
        </p>
      ) : null}
      {photoOpen && (load.kind === "ready" || (load.kind === "loading" && load.reloading)) ? (
        <PhotoConfirm
          date={date}
          onLogged={(entry) =>
            setLoad((l) => (l.kind === "ready" ? { ...l, entries: [...l.entries, entry] } : l))
          }
          onClose={() => {
            setPhotoOpen(false);
            if (photo) router.replace(`/log/${date}`, { scroll: false });
          }}
        />
      ) : null}
      {load.kind === "ready" ? (
        <Entries
          date={date}
          photoOpen={photoOpen}
          onPhoto={() => setPhotoOpen(true)}
          entries={load.entries}
          // An updater, not a list: two rows can settle in either order, and each must apply to the
          // entries as they are then, not as they were when its request started.
          onChange={(update) =>
            setLoad((l) => (l.kind === "ready" ? { ...l, entries: update(l.entries) } : l))
          }
          onStale={reload}
        />
      ) : null}
    </main>
  );
}

function DayNav({ date, today }: { date: string; today?: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState(date);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (/^\d{4}-\d{2}-\d{2}$/.test(picked) && picked !== date) router.push(`/log/${picked}`);
  }

  return (
    <div className={styles.dayNav}>
      <nav aria-label="Days" className={styles.dayLinks}>
        <Link href={`/log/${addDays(date, -1)}`} rel="prev">
          ← Previous day
        </Link>
        {today && date !== today ? <Link href={`/log/${today}`}>Today</Link> : null}
        {today && date < today ? (
          <Link href={`/log/${addDays(date, 1)}`} rel="next">
            Next day →
          </Link>
        ) : null}
      </nav>
      <form className={styles.datePicker} onSubmit={onSubmit}>
        <label htmlFor="log-date">Go to date</label>
        <input
          id="log-date"
          type="date"
          value={picked}
          max={today}
          onChange={(e) => setPicked(e.target.value)}
          required
        />
        <button type="submit">Go</button>
      </form>
    </div>
  );
}

function Entries({
  date,
  photoOpen,
  onPhoto,
  entries,
  onChange,
  onStale,
}: {
  date: string;
  photoOpen: boolean;
  onPhoto: () => void;
  entries: LogEntryView[];
  onChange: (update: (entries: LogEntryView[]) => LogEntryView[]) => void;
  onStale: () => void;
}) {
  const replace = (next: LogEntryView) =>
    onChange((list) => list.map((e) => (e.id === next.id ? next : e)));
  const remove = (id: string) => onChange((list) => list.filter((e) => e.id !== id));
  const totalGrams = entries.reduce((sum, e) => sum + e.grams, 0);

  return (
    <>
      <div className={styles.summaryRow}>
        <p data-testid="day-summary">
          {entries.length === 0
            ? "Nothing logged on this day."
            : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${formatGrams(totalGrams)} g in all`}
        </p>
        <div className={styles.addActions}>
          <Link href={`/search?date=${date}`} className="button-link" data-testid="day-add-food">
            Add food
          </Link>
          {photoOpen ? null : (
            <button type="button" onClick={onPhoto} data-testid="day-add-photo">
              Log by photo
            </button>
          )}
        </div>
      </div>
      {MEALS.map((meal) => {
        const items = entries.filter((e) => e.meal === meal);
        if (items.length === 0) return null;
        return (
          <section key={meal} aria-labelledby={`meal-${meal}`} data-testid={`meal-${meal}`}>
            <h2 id={`meal-${meal}`} className={styles.mealHeading}>
              {MEAL_LABELS[meal]}
            </h2>
            <ul className={styles.entryList}>
              {items.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  onUpdated={replace}
                  onDeleted={() => remove(entry.id)}
                  onStale={onStale}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

type Mode = "view" | "edit" | "confirmDelete";

function EntryRow({
  entry,
  onUpdated,
  onDeleted,
  onStale,
}: {
  entry: LogEntryView;
  onUpdated: (entry: LogEntryView) => void;
  onDeleted: () => void;
  onStale: () => void;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [grams, setGrams] = useState(String(entry.grams));
  const [meal, setMeal] = useState<Meal>(entry.meal);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const name = entry.description ?? `Food ${entry.fdcId}`;

  function cancel() {
    setMode("view");
    setGrams(String(entry.grams));
    setMeal(entry.meal);
    setError(null);
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      return await action();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const amount = Number(grams);
    const parsed = LogEntryUpdateInput.safeParse({ grams: amount, meal });
    if (!grams.trim() || !parsed.success) {
      setError(
        amount > MAX_LOG_GRAMS
          ? `One entry can be at most ${MAX_LOG_GRAMS.toLocaleString("en-US")} g.`
          : "Enter an amount in grams, more than 0.",
      );
      return;
    }
    if (parsed.data.grams === entry.grams && parsed.data.meal === entry.meal) {
      setError(null);
      setMode("view");
      return;
    }
    const result = await run(() => updateLog(entry.id, parsed.data));
    if (!result) return;
    if (result.ok) {
      setMode("view");
      onUpdated(result.data);
    } else if (result.failure.error === "log_not_found") {
      onStale(); // deleted elsewhere: show the day as it is now
    } else {
      setError(result.failure.message);
    }
  }

  async function onDelete() {
    const result = await run(() => deleteLog(entry.id));
    if (!result) return;
    // Already gone (another tab) counts as deleted.
    if (result.ok || result.failure.error === "log_not_found") onDeleted();
    else setError(result.failure.message);
  }

  return (
    <li className={styles.entry} data-testid="log-entry">
      <div className={styles.entryMain}>
        <Link href={foodHref(entry.fdcId)} className={styles.entryName}>
          {name}
        </Link>
        <span className={styles.entryMeta}>
          <span data-testid="entry-grams">{formatGrams(entry.grams)} g</span>
          {entry.source === "photo" ? (
            // Display only (design doc C5: per-entry vision confidence is not used in any formula).
            <span> · Photo estimate, {Math.round(entry.confidence * 100)}% confidence</span>
          ) : null}
        </span>
      </div>

      {mode === "view" ? (
        <div className={styles.entryActions}>
          <button type="button" onClick={() => setMode("edit")} aria-label={`Edit ${name}`}>
            Edit
          </button>
          <button
            type="button"
            onClick={() => setMode("confirmDelete")}
            aria-label={`Delete ${name}`}
          >
            Delete
          </button>
        </div>
      ) : null}

      {mode === "edit" ? (
        <form className={styles.editForm} onSubmit={onSave} noValidate>
          <label htmlFor={`entry-grams-${entry.id}`}>Amount (g)</label>
          <input
            id={`entry-grams-${entry.id}`}
            type="number"
            inputMode="decimal"
            min={0.1}
            max={MAX_LOG_GRAMS}
            step="any"
            value={grams}
            onChange={(e) => setGrams(e.target.value)}
          />
          <label htmlFor={`entry-meal-${entry.id}`}>Meal</label>
          <select
            id={`entry-meal-${entry.id}`}
            value={meal}
            onChange={(e) => setMeal(e.target.value as Meal)}
          >
            {MEALS.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABELS[m]}
              </option>
            ))}
          </select>
          <div className={styles.entryActions}>
            <button
              type="submit"
              className="primary"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={cancel} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {mode === "confirmDelete" ? (
        <div className={styles.confirm} role="group" aria-label={`Delete ${name}?`}>
          <span>Delete this entry?</span>
          <button
            type="button"
            className={styles.danger}
            onClick={() => void onDelete()}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Deleting…" : "Yes, delete"}
          </button>
          <button type="button" onClick={cancel} disabled={pending}>
            Cancel
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
