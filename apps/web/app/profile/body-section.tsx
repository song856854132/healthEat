"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { ACTIVITY_LEVELS, MemberProfileInput, SEXES } from "@healtheat/shared";
import type { MemberProfileView } from "@healtheat/shared";
import { useAuth } from "../auth-context";
import { Field, SelectField } from "../field";
import { getMemberProfile, updateMemberProfile } from "../lib/account";
import { browserTimeZone } from "../lib/form";
import { useLoad } from "../use-load";
import { confirmSession } from "./session";
import styles from "./profile.module.css";

// The member's body details, calorie band and time zone on /profile (T31; design doc, Data model:
// MemberProfile; D4). Member Home's calorie meter uses the member's own band when set, else one computed
// from sex, birth year, height, weight and activity (Mifflin-St Jeor x activity, plus or minus 10%), and
// shows a prompt when neither is possible. The time zone decides what "today" is for logs and the meter.
// The PUT sends only these fields, so the sharing choices are left as they are.

type Sex = (typeof SEXES)[number];
type Activity = (typeof ACTIVITY_LEVELS)[number];

const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "unspecified", label: "Prefer not to say" },
];

const ACTIVITY_OPTIONS: { value: Activity; label: string }[] = [
  { value: "sedentary", label: "Sedentary: little or no exercise" },
  { value: "light", label: "Light: exercise 1 to 3 days a week" },
  { value: "moderate", label: "Moderate: exercise 3 to 5 days a week" },
  { value: "active", label: "Active: exercise 6 or 7 days a week" },
  { value: "very_active", label: "Very active: hard daily exercise or a physical job" },
];

type Values = {
  sex: Sex;
  birthYear: string;
  heightCm: string;
  weightKg: string;
  activityLevel: Activity;
  bandLow: string;
  bandHigh: string;
  timezone: string;
};
type Errors = Partial<Record<keyof Values | "form", string>>;

const toValues = (p: MemberProfileView): Values => ({
  sex: p.sex,
  birthYear: p.birthYear?.toString() ?? "",
  heightCm: p.heightCm?.toString() ?? "",
  weightKg: p.weightKg?.toString() ?? "",
  activityLevel: p.activityLevel,
  bandLow: p.calorieBand?.low.toString() ?? "",
  bandHigh: p.calorieBand?.high.toString() ?? "",
  timezone: p.timezone,
});

/** "" -> null, a number -> that number, anything else -> NaN (reported as "enter a number"). */
const numberOrNull = (text: string) => (text.trim() === "" ? null : Number(text.trim()));

/** zod's wording for a body field, said in the units the form shows. */
function friendly(field: keyof Errors, code: string, whole: boolean, message: string): string {
  const integer = field === "birthYear" || field === "bandLow" || field === "bandHigh";
  if (code === "invalid_type") return integer ? "Use a whole number." : "Enter a number.";
  switch (field) {
    case "birthYear":
      return `A year from 1900 to ${new Date().getFullYear()}.`;
    case "heightCm":
      return "From 50 to 272 cm.";
    case "weightKg":
      return "From 20 to 500 kg.";
    case "bandLow":
    case "bandHigh":
      // A refine on the whole band (no sub-path) is the low-above-high check.
      return whole ? "The low end must not be above the high end." : "From 0 to 10,000 kcal.";
    case "timezone":
      return "Not a time zone this browser knows. Pick one from the suggestions.";
    default:
      return message;
  }
}

/** What Member Home's calorie meter will use, from the saved profile (summary.ts calorieBandFor). */
function meterBasis(p: MemberProfileView): string {
  if (p.calorieBand)
    return `Home’s calorie meter uses your own band: ${p.calorieBand.low.toLocaleString("en-US")} to ${p.calorieBand.high.toLocaleString("en-US")} kcal a day.`;
  if ((p.sex === "female" || p.sex === "male") && p.birthYear && p.heightCm && p.weightKg)
    return "Home’s calorie meter uses a band computed from these details and your activity level.";
  return "To see the calorie meter on Home, choose female or male and add your birth year, height and weight, or set your own band.";
}

/** Every IANA zone this browser knows, for the time zone suggestions (empty where unsupported). */
function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function BodySection({ username }: { username: string }) {
  const [state, retry] = useLoad(getMemberProfile);
  return (
    <section id="body" aria-labelledby="body-heading" data-testid="body-settings">
      <h2 id="body-heading">Body details and calorie band</h2>
      <p className="hint">
        Used for your nutrient targets and today’s calorie meter. Never shown to anyone else.
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
      {state.kind === "done" ? <BodyForm username={username} initial={state.data} /> : null}
    </section>
  );
}

function BodyForm({ username, initial }: { username: string; initial: MemberProfileView }) {
  const { recheck } = useAuth();
  const [profile, setProfile] = useState(initial);
  const [values, setValues] = useState<Values>(() => toValues(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [zones] = useState(knownTimeZones);
  const here = browserTimeZone();

  const set = (field: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setSaved(false);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(false);
    const found: Errors = {};
    const low = numberOrNull(values.bandLow);
    const high = numberOrNull(values.bandHigh);
    if ((low === null) !== (high === null)) {
      found[low === null ? "bandLow" : "bandHigh"] = "Set both ends of the band, or clear both.";
    }
    const body = {
      sex: values.sex,
      birthYear: numberOrNull(values.birthYear),
      heightCm: numberOrNull(values.heightCm),
      weightKg: numberOrNull(values.weightKg),
      activityLevel: values.activityLevel,
      calorieBand: low !== null && high !== null ? { low, high } : null,
      timezone: values.timezone,
    };
    const parsed = MemberProfileInput.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [head, sub] = issue.path;
        const field: keyof Errors =
          head === "calorieBand"
            ? sub === "high"
              ? "bandHigh"
              : "bandLow"
            : (String(head) as keyof Errors);
        found[field] ??= friendly(field, issue.code, sub === undefined, issue.message);
      }
    }
    if (Object.keys(found).length || !parsed.success) {
      setErrors(Object.keys(found).length ? found : { form: "Check the form." });
      return;
    }

    busy.current = true;
    setPending(true);
    setErrors({});
    try {
      const switched = await confirmSession(recheck, username);
      if (switched) {
        setErrors({ form: switched });
        return;
      }
      const result = await updateMemberProfile(parsed.data);
      if (result.ok) {
        setProfile(result.data);
        setValues(toValues(result.data));
        setSaved(true);
      } else setErrors({ form: result.failure.message });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate data-testid="body-form">
      <fieldset disabled={pending} className={styles.fieldset}>
        {errors.form ? (
          <p role="alert" className="form-error">
            {errors.form}
          </p>
        ) : null}
        <SelectField
          name="sex"
          label="Sex"
          options={SEX_OPTIONS}
          value={values.sex}
          onChange={(e) => set("sex")(e.target.value)}
          hint="Picks your nutrient targets. Without female or male, targets use an adult reference and the calorie band cannot be computed."
          error={errors.sex}
        />
        <div className={styles.pair}>
          <Field
            name="birthYear"
            label="Birth year"
            type="number"
            inputMode="numeric"
            value={values.birthYear}
            onChange={(e) => set("birthYear")(e.target.value)}
            error={errors.birthYear}
          />
          <Field
            name="heightCm"
            label="Height (cm)"
            type="number"
            inputMode="decimal"
            value={values.heightCm}
            onChange={(e) => set("heightCm")(e.target.value)}
            error={errors.heightCm}
          />
          <Field
            name="weightKg"
            label="Weight (kg)"
            type="number"
            inputMode="decimal"
            value={values.weightKg}
            onChange={(e) => set("weightKg")(e.target.value)}
            error={errors.weightKg}
          />
        </div>
        <SelectField
          name="activityLevel"
          label="Activity level"
          options={ACTIVITY_OPTIONS}
          value={values.activityLevel}
          onChange={(e) => set("activityLevel")(e.target.value)}
          error={errors.activityLevel}
        />
        <div className={styles.pair}>
          <Field
            name="bandLow"
            label="Your own calorie band: from (kcal)"
            type="number"
            inputMode="numeric"
            value={values.bandLow}
            onChange={(e) => set("bandLow")(e.target.value)}
            error={errors.bandLow}
          />
          <Field
            name="bandHigh"
            label="to (kcal)"
            type="number"
            inputMode="numeric"
            value={values.bandHigh}
            onChange={(e) => set("bandHigh")(e.target.value)}
            error={errors.bandHigh}
          />
        </div>
        <p className="hint">
          Optional. When set, it replaces the computed band. Clear both to go back to the computed
          one.
        </p>
        <Field
          name="timezone"
          label="Time zone"
          list="timezone-options"
          autoCapitalize="none"
          spellCheck={false}
          value={values.timezone}
          onChange={(e) => set("timezone")(e.target.value)}
          hint="Decides what “today” means for your log and the calorie meter."
          error={errors.timezone}
        />
        {zones.length ? (
          <datalist id="timezone-options">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        ) : null}
        {values.timezone !== here ? (
          <p>
            <button type="button" onClick={() => set("timezone")(here)}>
              Use this browser’s time zone ({here})
            </button>
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="submit"
            className="primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Saving…" : "Save details"}
          </button>
          {saved ? (
            <span role="status" className="hint">
              Saved.
            </span>
          ) : null}
        </div>
        <p className="hint" data-testid="meter-basis">
          {meterBasis(profile)}
        </p>
      </fieldset>
    </form>
  );
}
