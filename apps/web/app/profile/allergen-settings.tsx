"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { UserAllergensInput } from "@healtheat/shared";
import type { AllergenMode, AllergenTier, AllergenView, UserAllergenView } from "@healtheat/shared";
import { useAuth } from "../auth-context";
import { listAllergens } from "../lib/curate";
import { allergenSaveError, getMyAllergens, setMyAllergens } from "../lib/settings";
import type { Result } from "../lib/foods";
import { useLoad } from "../use-load";
import { scrollToProfileAnchor } from "./anchor";
import { confirmSession } from "./session";
import manage from "../manage.module.css";
import styles from "./profile.module.css";

// The member's allergen list on /profile (T31; design doc, Data model: UserAllergen `mode`,
// `weeklyThreshold`; the wireframe: "Thresholds are yours to set in Profile"). Avoid raises the hard
// alert strip on Member Home when today's log contains the allergen; Track counts hits toward the weekly
// exposure meter, against an optional threshold. Saving sends the complete list, which replaces the
// stored one, so the stored list is read again first: a choice saved from another tab or device after
// this page loaded (a new Avoid, say) is never silently dropped.

type Choice = "" | AllergenMode;
/** `unreadable`: the threshold's text is not a number the browser can read (it reports ""). */
type Row = { mode: Choice; threshold: string; unreadable?: boolean };
type Loaded = { dictionary: AllergenView[]; mine: UserAllergenView[] };

const THRESHOLD_ERROR = "A whole number from 1 to 1,000, or leave it empty.";

const STALE =
  "Your allergen choices changed in another tab or device since this page loaded. Nothing was saved; the list below is as stored now. Make your change again.";

/** The stored list as a comparable string: key, mode and threshold of each entry, by key. */
const listKey = (list: UserAllergenView[]) =>
  JSON.stringify(
    [...list]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((a) => [a.key, a.mode, a.weeklyThreshold]),
  );

const TIER_HINT: Record<AllergenTier, string> = {
  allergy: "usually avoided",
  sensitivity: "usually tracked",
  both: "avoid or track",
};

async function loadSettings(signal: AbortSignal): Promise<Result<Loaded>> {
  const [dictionary, mine] = await Promise.all([listAllergens(signal), getMyAllergens(signal)]);
  if (!dictionary.ok) return dictionary;
  if (!mine.ok) return mine;
  return {
    ok: true,
    data: { dictionary: dictionary.data.allergens, mine: mine.data.allergens },
  };
}

function rowsFrom(dictionary: AllergenView[], mine: UserAllergenView[]): Record<string, Row> {
  const rows: Record<string, Row> = {};
  for (const a of dictionary) rows[a.key] = { mode: "", threshold: "" };
  for (const m of mine)
    rows[m.key] = { mode: m.mode, threshold: m.weeklyThreshold ? String(m.weeklyThreshold) : "" };
  return rows;
}

export function AllergenSettingsSection({ username }: { username: string }) {
  const [state, retry] = useLoad(loadSettings);
  useEffect(() => {
    if (state.kind === "done") scrollToProfileAnchor();
  }, [state.kind]);
  return (
    <section id="allergens" aria-labelledby="allergens-heading" data-testid="allergen-settings">
      <h2 id="allergens-heading">Allergens and sensitivities</h2>
      <p className="hint">
        Avoid: any trace in today’s log raises an alert on Home. Track: hits count toward your
        weekly exposure meter, against a threshold you can set. This is a pattern aid, not medical
        advice.
      </p>
      {state.kind === "loading" ? <p className="hint">Loading…</p> : null}
      {state.kind === "error" ? (
        <>
          <p className="form-error">{state.failure.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </>
      ) : null}
      {state.kind === "done" ? (
        <AllergenForm
          username={username}
          dictionary={state.data.dictionary}
          mine={state.data.mine}
        />
      ) : null}
    </section>
  );
}

function AllergenForm({
  username,
  dictionary,
  mine,
}: {
  username: string;
  dictionary: AllergenView[];
  mine: UserAllergenView[];
}) {
  const { recheck } = useAuth();
  const [rows, setRows] = useState(() => rowsFrom(dictionary, mine));
  // The stored list the rows were last filled from; a save first checks it is still what is stored.
  const [base, setBase] = useState(mine);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const chosen = Object.values(rows);
  const avoiding = chosen.filter((r) => r.mode === "avoid").length;
  const tracking = chosen.filter((r) => r.mode === "track").length;

  function update(key: string, change: Partial<Row>) {
    setRows((r) => ({ ...r, [key]: { ...r[key], ...change } }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    setSaved(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(false);
    setFormError(null);
    const found: Record<string, string> = {};
    const allergens: UserAllergensInput["allergens"] = [];
    for (const a of dictionary) {
      const row = rows[a.key];
      if (!row?.mode) continue;
      if (row.mode === "avoid") {
        allergens.push({ key: a.key, mode: "avoid" });
        continue;
      }
      const text = row.threshold.trim();
      const n = Number(text);
      if (row.unreadable || (text && !(Number.isInteger(n) && n >= 1 && n <= 1000))) {
        found[a.key] = THRESHOLD_ERROR;
        continue;
      }
      allergens.push(
        text ? { key: a.key, mode: "track", weeklyThreshold: n } : { key: a.key, mode: "track" },
      );
    }
    const parsed = UserAllergensInput.safeParse({ allergens });
    if (Object.keys(found).length || !parsed.success) {
      setErrors(found);
      if (!Object.keys(found).length) setFormError("Check the form.");
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const switched = await confirmSession(recheck, username);
      if (switched) {
        setFormError(switched);
        return;
      }
      const fresh = await getMyAllergens();
      if (!fresh.ok) {
        setFormError(fresh.failure.message);
        return;
      }
      if (listKey(fresh.data.allergens) !== listKey(base)) {
        setBase(fresh.data.allergens);
        setRows(rowsFrom(dictionary, fresh.data.allergens));
        setErrors({});
        setFormError(STALE);
        return;
      }
      const result = await setMyAllergens(parsed.data);
      if (result.ok) {
        setBase(result.data.allergens);
        setRows(rowsFrom(dictionary, result.data.allergens));
        setSaved(true);
      } else setFormError(allergenSaveError(result.failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (dictionary.length === 0)
    return (
      <p className="hint">The allergen dictionary is empty, so there is nothing to choose yet.</p>
    );

  return (
    <form
      className={manage.form}
      onSubmit={onSubmit}
      noValidate
      data-testid="allergen-settings-form"
    >
      <fieldset disabled={pending} className={styles.fieldset}>
        {formError ? (
          <p role="alert" className="form-error">
            {formError}
          </p>
        ) : null}
        <p data-testid="allergen-counts">
          Avoiding {avoiding} · tracking {tracking}
        </p>
        <div className={manage.tableWrap}>
          <table className={`${manage.table} ${styles.settingsTable}`}>
            <thead>
              <tr>
                <th scope="col">Allergen</th>
                <th scope="col">Your choice</th>
                <th scope="col">Weekly threshold</th>
              </tr>
            </thead>
            <tbody>
              {dictionary.map((a) => {
                const row = rows[a.key] ?? { mode: "", threshold: "" };
                const errorId = `threshold-${a.key}-error`;
                return (
                  <tr key={a.key} data-testid="allergen-setting">
                    <th scope="row">
                      {a.displayName}
                      <div className={manage.muted}>{TIER_HINT[a.tier]}</div>
                    </th>
                    <td>
                      <select
                        className={styles.control}
                        aria-label={`Your choice for ${a.displayName}`}
                        value={row.mode}
                        onChange={(e) => update(a.key, { mode: e.target.value as Choice })}
                      >
                        <option value="">Not set</option>
                        <option value="avoid">Avoid</option>
                        <option value="track">Track</option>
                      </select>
                    </td>
                    <td>
                      {row.mode === "track" ? (
                        <>
                          <input
                            className={`${styles.control} ${styles.threshold}`}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={1000}
                            step={1}
                            placeholder="none"
                            aria-label={`Weekly threshold for ${a.displayName}`}
                            aria-invalid={errors[a.key] ? true : undefined}
                            aria-describedby={errors[a.key] ? errorId : undefined}
                            value={row.threshold}
                            onChange={(e) =>
                              update(a.key, {
                                threshold: e.target.value,
                                unreadable: e.target.validity.badInput,
                              })
                            }
                          />
                          {errors[a.key] ? (
                            <p id={errorId} className="field-error">
                              {errors[a.key]}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <span className={manage.muted}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          A threshold is hits per 7 days; the meter says when you are above it. Without one, the
          meter shows the count only.
        </p>
        <div className={styles.actions}>
          <button
            type="submit"
            className="primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Saving…" : "Save allergens"}
          </button>
          {saved ? (
            <span role="status" className="hint">
              Saved.
            </span>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
