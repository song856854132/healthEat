"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { LogEntryCreateInput, MAX_LOG_GRAMS, MEALS } from "@healtheat/shared";
import type { AllergenAlert, LogEntryView, Meal } from "@healtheat/shared";
import { logFood } from "../../lib/foods";
import { formatAmount } from "../../lib/nutrients";
import styles from "../../foods.module.css";

const MEAL_LABELS: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

/** A starting meal from the browser's clock; the user can change it. */
export function mealForHour(hour: number): Meal {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snack";
}

type Outcome =
  | { kind: "logged"; entry: LogEntryView; alerts: AllergenAlert[] }
  | { kind: "signedOut" }
  | { kind: "error"; message: string };

/**
 * "Log this" on Details (design doc, Pages table: member column "log and portion"). Anyone sees the
 * form; identity is asked for only on submit (design doc: "Identity is requested only at the moment
 * it is needed"), so a signed-out visitor gets a log-in prompt instead of a hidden button. Logs to
 * today in the member's time zone (the API's default).
 */
export function LogForm({ fdcId, grams }: { fdcId: number; grams: number }) {
  const [meal, setMeal] = useState<Meal>(() => mealForHour(new Date().getHours()));
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    if (!(grams > 0)) {
      setOutcome({ kind: "error", message: "Enter an amount in grams." });
      return;
    }
    const parsed = LogEntryCreateInput.safeParse({ fdcId, grams, meal });
    if (!parsed.success) {
      setOutcome({
        kind: "error",
        message:
          grams > MAX_LOG_GRAMS
            ? `One entry can be at most ${MAX_LOG_GRAMS.toLocaleString("en-US")} g.`
            : "That amount cannot be logged.",
      });
      return;
    }
    busy.current = true;
    setPending(true);
    setOutcome(null);
    const result = await logFood(parsed.data);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOutcome({ kind: "logged", entry: result.data.entry, alerts: result.data.alerts });
    } else if (result.failure.status === 401) {
      setOutcome({ kind: "signedOut" });
    } else {
      setOutcome({ kind: "error", message: result.failure.message });
    }
  }

  return (
    <form id="log" className={styles.logForm} onSubmit={onSubmit} noValidate>
      <label htmlFor="log-meal">Meal</label>
      <select id="log-meal" value={meal} onChange={(e) => setMeal(e.target.value as Meal)}>
        {MEALS.map((m) => (
          <option key={m} value={m}>
            {MEAL_LABELS[m]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className={styles.primary}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending ? "Logging…" : grams > 0 ? `Log ${formatAmount(grams)} g` : "Log this"}
      </button>
      <div aria-live="polite" className={styles.logOutcome}>
        {outcome ? <OutcomeView outcome={outcome} /> : null}
      </div>
    </form>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "signedOut") {
    return (
      <p data-testid="log-signed-out">
        <Link href="/login">Log in</Link> or <Link href="/register">create an account</Link> to log
        this food.
      </p>
    );
  }
  if (outcome.kind === "error") {
    return (
      <p className={styles.errorText} data-testid="log-error">
        {outcome.message}
      </p>
    );
  }
  const { entry, alerts } = outcome;
  return (
    <>
      {alerts.length > 0 ? (
        // Hard alert (design doc: an avoid-mode allergen the moment it is logged).
        <div className={styles.alert} role="alert" data-testid="log-alert">
          <strong>Contains {alerts.map((a) => a.displayName).join(", ")}</strong>, which you avoid.
        </div>
      ) : null}
      <p data-testid="log-done">
        Logged {formatAmount(entry.grams)} g to {MEAL_LABELS[entry.meal].toLowerCase()} on{" "}
        {entry.date}.
      </p>
    </>
  );
}
