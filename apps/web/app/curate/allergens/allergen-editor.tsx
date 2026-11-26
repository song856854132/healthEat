"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ALLERGEN_TIERS, AllergenCreateInput, AllergenUpdateInput } from "@healtheat/shared";
import type { AllergenTier, AllergenView, RematchProgress } from "@healtheat/shared";
import { RoleGate } from "../../role-gate";
import { Field, SelectField, TextAreaField } from "../../field";
import {
  TIER_LABELS,
  allergenHref,
  createAllergen,
  deleteAllergen,
  deleteRefusal,
  listAllergens,
  parsePhrases,
  updateAllergen,
} from "../../lib/curate";
import { fieldErrors } from "../../lib/request";
import { LoadError, useLoad } from "../../use-load";
import { RematchControl } from "../rematch";
import styles from "../../manage.module.css";

// /curate/allergens/new and /curate/allergens/[key] (design doc, Pages table: per-allergen synonyms and
// description keywords, re-match status and "Continue re-match"). A save sends every field (PUT replaces
// them) and the API re-matches the cached foods in the same request: 200/201 when done, 202 when the
// 60-second budget ran out and "Continue re-match" finishes it.

const TIER_OPTIONS = ALLERGEN_TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] }));

/** The static /curate/allergens/new route shadows an entry keyed "new", so that key is refused here. */
const RESERVED_KEYS = new Set(["new"]);

const LIST_FIELDS = ["synonyms", "descriptionKeywords", "excludePhrases"] as const;

/**
 * The matcher splits a label's ingredients at these (apps/api/src/services/dictionary.ts,
 * ingredientSegments), so a synonym or exclude phrase holding one can never match a single ingredient.
 * Commas already separate phrases here. Description keywords are matched against the whole food name,
 * which is not split, so they may keep punctuation.
 */
const SPLIT_PUNCTUATION = /[;:.()[\]{}]/;
const SPLIT_FIELDS = ["synonyms", "excludePhrases"] as const;

const STALE =
  "This entry changed since you opened it (another Curator saved it). Nothing was saved; the form now shows it as stored. Make your change again.";

/** The fields a save replaces, compared with the stored entry before writing over it. */
const sameEntry = (a: AllergenView, b: AllergenView) =>
  JSON.stringify([a.displayName, a.tier, a.synonyms, a.descriptionKeywords, a.excludePhrases]) ===
  JSON.stringify([b.displayName, b.tier, b.synonyms, b.descriptionKeywords, b.excludePhrases]);
type ListField = (typeof LIST_FIELDS)[number];

type Values = {
  key: string;
  displayName: string;
  tier: AllergenTier;
  synonyms: string;
  descriptionKeywords: string;
  excludePhrases: string;
};
type Errors = Partial<Record<keyof Values | "form", string>>;

const toValues = (a?: AllergenView): Values => ({
  key: a?.key ?? "",
  displayName: a?.displayName ?? "",
  tier: a?.tier ?? "allergy",
  synonyms: a?.synonyms.join("\n") ?? "",
  descriptionKeywords: a?.descriptionKeywords.join("\n") ?? "",
  excludePhrases: a?.excludePhrases.join("\n") ?? "",
});

/** zod's wording for a list field's issue, said in terms of the phrases the Curator typed. */
function listMessage(path: readonly PropertyKey[], code: string, message: string): string {
  if (path.length > 1)
    return code === "too_big" ? "Each phrase is at most 80 characters." : message;
  return code === "too_big" ? "At most 200 phrases." : message;
}

// ---- new -----------------------------------------------------------------------------------------

export function NewAllergen() {
  return (
    <RoleGate role="curator" title="Add allergen">
      {() => (
        <main className={styles.view}>
          <p>
            <Link href="/curate/allergens">← Allergen dictionary</Link>
          </p>
          <h1>Add allergen</h1>
          <AllergenForm />
        </main>
      )}
    </RoleGate>
  );
}

// ---- edit ----------------------------------------------------------------------------------------

export function EditAllergen({ allergenKey, added }: { allergenKey: string; added: boolean }) {
  return (
    <RoleGate role="curator" title="Edit allergen">
      {() => <Editor allergenKey={allergenKey} added={added} />}
    </RoleGate>
  );
}

function Editor({ allergenKey, added }: { allergenKey: string; added: boolean }) {
  const router = useRouter();
  const [dictionary, retry] = useLoad(listAllergens);
  // "Added to the dictionary" shows once: the ?added=1 the create form sent is dropped from the URL, so
  // a reload or a shared link does not say it again.
  const [justAdded] = useState(added);
  useEffect(() => {
    if (added) router.replace(allergenHref(allergenKey));
  }, [added, allergenKey, router]);
  const [deleted, setDeleted] = useState<string | null>(null);
  // The entry as the last save (or finished re-match) left it; the loaded copy until then. Kept here
  // rather than refetched, so finishing a re-match never resets a form with unsaved edits.
  const [current, setCurrent] = useState<AllergenView | null>(null);
  // The progress the last save answered, for "N foods left"; `run` restarts the control on each save, and
  // `finished` keeps it on screen saying "Re-match done" once a Continue finished it.
  const [rematch, setRematch] = useState<{
    run: number;
    progress?: RematchProgress;
    finished?: boolean;
  }>({ run: 0 });
  // A Continue still running when a save restarted the control must not report into the newer run.
  const runRef = useRef(0);
  const allergen =
    current ??
    (dictionary.kind === "done"
      ? dictionary.data.allergens.find((a) => a.key === allergenKey)
      : undefined);

  const run = rematch.run;

  if (deleted)
    return (
      <main className={styles.view}>
        <h1>Allergen deleted</h1>
        <p role="status" data-testid="allergen-deleted">
          {deleted} is no longer in the dictionary, and its matches were removed from every food.
        </p>
        <p>
          <Link href="/curate/allergens">Back to the dictionary</Link>
        </p>
      </main>
    );

  return (
    <main className={styles.view}>
      <p>
        <Link href="/curate/allergens">← Allergen dictionary</Link>
      </p>
      <h1>{allergen ? allergen.displayName : "Edit allergen"}</h1>
      {dictionary.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading…
        </p>
      ) : dictionary.kind === "error" ? (
        <LoadError failure={dictionary.failure} retry={retry} testId="allergen-error" />
      ) : !allergen ? (
        <p data-testid="allergen-missing">
          There is no allergen with the key <code>{allergenKey}</code>; it may have been deleted.{" "}
          <Link href="/curate/allergens">Back to the dictionary</Link>
        </p>
      ) : (
        <>
          {justAdded ? (
            <p role="status" className="hint" data-testid="allergen-added">
              Added to the dictionary.
            </p>
          ) : null}
          <p className={styles.sub}>
            Key <code>{allergen.key}</code> (its address; it never changes) ·{" "}
            {allergen.source === "curator" ? "edited by a Curator" : "as seeded"}
          </p>
          {allergen.rematchPending || rematch.finished ? (
            <p className={styles.progress} data-testid="allergen-rematch">
              <RematchControl
                key={rematch.run}
                id={allergen.id}
                name={allergen.displayName}
                initial={rematch.progress}
                onDone={() => {
                  if (run !== runRef.current) return;
                  setCurrent((c) => ({ ...(c ?? allergen), rematchPending: false }));
                  setRematch((r) => ({ ...r, finished: true }));
                }}
              />
            </p>
          ) : null}
          <AllergenForm
            key={allergen.id}
            allergen={allergen}
            rematchPending={allergen.rematchPending}
            onSaved={(written, progress) => {
              runRef.current += 1;
              setCurrent(written);
              setRematch({ run: runRef.current, progress });
            }}
            onStale={(stored) => {
              // The stored copy decides the re-match status now: restart the control without the
              // progress an earlier save of this page answered.
              runRef.current += 1;
              setCurrent(stored);
              setRematch({ run: runRef.current });
            }}
          />
          <DeleteAllergen allergen={allergen} onDeleted={() => setDeleted(allergen.displayName)} />
        </>
      )}
    </main>
  );
}

// ---- the form ------------------------------------------------------------------------------------

/**
 * Without `allergen`, a new entry (POST), which then opens its own page; with it, every editable field
 * of that entry (PUT), reported to `onSaved` with the re-match progress the write answered. The PUT
 * replaces every field, so the stored entry is read first: if another Curator changed it since this
 * form was filled from it, nothing is written and `onStale` gets the stored copy.
 */
function AllergenForm({
  allergen,
  rematchPending = false,
  onSaved,
  onStale,
}: {
  allergen?: AllergenView;
  rematchPending?: boolean;
  onSaved?: (written: AllergenView, rematch: RematchProgress) => void;
  onStale?: (stored: AllergenView) => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => toValues(allergen));
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<RematchProgress | null>(null);
  const busy = useRef(false);
  const creating = !allergen;

  const set = (field: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setSaved(null);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(null);
    const body = {
      displayName: values.displayName.trim(),
      tier: values.tier,
      synonyms: parsePhrases(values.synonyms),
      descriptionKeywords: parsePhrases(values.descriptionKeywords),
      excludePhrases: parsePhrases(values.excludePhrases),
    };
    const key = values.key.trim().toLowerCase();
    const parsed = creating
      ? AllergenCreateInput.safeParse({ key, ...body })
      : AllergenUpdateInput.safeParse(body);
    const found: Errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "form") as keyof Errors;
        found[field] ??= LIST_FIELDS.includes(field as ListField)
          ? listMessage(issue.path, issue.code, issue.message)
          : field === "displayName" && issue.code === "too_small"
            ? "Give the allergen a name."
            : issue.message;
      }
    }
    if (creating && RESERVED_KEYS.has(key)) found.key = "That key is reserved. Choose another.";
    for (const field of SPLIT_FIELDS) {
      const split = body[field].find((phrase) => SPLIT_PUNCTUATION.test(phrase));
      if (split)
        found[field] ??=
          `“${split}” has punctuation that ingredient labels are split at (; : . or brackets), so it cannot match inside one ingredient. Write the words without it.`;
    }
    if (body.synonyms.length === 0 && body.descriptionKeywords.length === 0)
      found.synonyms ??= "Add at least one synonym or description keyword, or nothing will match.";
    if (Object.keys(found).length > 0 || !parsed.success) {
      setErrors(Object.keys(found).length ? found : { form: "Check the form." });
      return;
    }

    busy.current = true;
    setPending(true);
    setErrors({});
    try {
      if (allergen) {
        const fresh = await listAllergens();
        if (!fresh.ok) {
          setErrors({ form: fresh.failure.message });
          return;
        }
        const stored = fresh.data.allergens.find((a) => a.id === allergen.id);
        if (!stored) {
          setErrors({
            form: "This allergen no longer exists; another Curator may have deleted it.",
          });
          return;
        }
        if (!sameEntry(stored, allergen)) {
          setValues(toValues(stored));
          onStale?.(stored);
          setErrors({ form: STALE });
          return;
        }
      }
      const result = allergen
        ? await updateAllergen(allergen.id, parsed.data as AllergenUpdateInput)
        : await createAllergen(parsed.data as AllergenCreateInput);
      if (!result.ok) {
        const fields = fieldErrors(result.failure) as Errors;
        if (result.failure.error === "conflict") fields.key = result.failure.message;
        setErrors(Object.keys(fields).length ? fields : { form: result.failure.message });
        return;
      }
      const written = result.data.allergen;
      if (creating) {
        // The new entry's own page shows its re-match status (from `rematchPending`) and the form.
        router.push(`${allergenHref(written.key)}?added=1`);
        return;
      }
      setValues(toValues(written));
      setSaved(result.data.rematch);
      onSaved?.(written, result.data.rematch);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate data-testid="allergen-form">
      <fieldset disabled={pending} className={styles.fieldset}>
        {errors.form ? (
          <p role="alert" className="form-error">
            {errors.form}
          </p>
        ) : null}
        {creating ? (
          <Field
            name="key"
            label="Key"
            autoCapitalize="none"
            spellCheck={false}
            value={values.key}
            onChange={(e) => set("key")(e.target.value)}
            hint="Lowercase letters, digits and single hyphens, such as tree-nuts. It is the entry’s address and never changes."
            error={errors.key}
          />
        ) : null}
        <Field
          name="displayName"
          label="Name"
          value={values.displayName}
          onChange={(e) => set("displayName")(e.target.value)}
          error={errors.displayName}
        />
        <SelectField
          name="tier"
          label="Tier"
          options={TIER_OPTIONS}
          value={values.tier}
          onChange={(e) => set("tier")(e.target.value)}
          hint="Allergy: any trace is a hard alert. Sensitivity: hits add up in the weekly exposure meter. Allergy or sensitivity: each member chooses."
          error={errors.tier}
        />
        <TextAreaField
          name="synonyms"
          label="Synonyms (ingredient text)"
          rows={6}
          value={values.synonyms}
          onChange={(e) => set("synonyms")(e.target.value)}
          hint="Words and phrases matched whole-word inside one ingredient of a label, such as soy lecithin. One per line, or separated by commas."
          error={errors.synonyms}
        />
        <TextAreaField
          name="descriptionKeywords"
          label="Description keywords"
          rows={4}
          value={values.descriptionKeywords}
          onChange={(e) => set("descriptionKeywords")(e.target.value)}
          hint="Matched whole-word in the food’s name, for foods without ingredient text and, for sensitivities, for every food. Shown as a food-category estimate."
          error={errors.descriptionKeywords}
        />
        <TextAreaField
          name="excludePhrases"
          label="Exclude phrases"
          rows={3}
          value={values.excludePhrases}
          onChange={(e) => set("excludePhrases")(e.target.value)}
          hint="Phrases that contain a synonym but are not this allergen, such as cocoa butter for milk."
          error={errors.excludePhrases}
        />
        <div className={styles.actions}>
          <button
            type="submit"
            className="primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Saving and re-matching…" : creating ? "Add allergen" : "Save and re-match"}
          </button>
          {saved ? (
            <span role="status" className="hint" data-testid="allergen-saved">
              {saved.done
                ? `Saved. Re-matched ${saved.processed} cached food${saved.processed === 1 ? "" : "s"}.`
                : rematchPending
                  ? "Saved. The re-match ran out of time with foods left: continue it above."
                  : "Saved, and the re-match has finished."}
            </span>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}

// ---- delete --------------------------------------------------------------------------------------

/**
 * Delete with confirmation: typing the key arms the button. The API refuses (409 allergen_avoided)
 * while any member avoids the allergen, so their alerts never vanish silently (#52).
 */
function DeleteAllergen({
  allergen,
  onDeleted,
}: {
  allergen: AllergenView;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const confirmed = typed.trim().toLowerCase() === allergen.key;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current || !confirmed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await deleteAllergen(allergen.id);
    // A 404 means another Curator deleted it first: the entry is gone either way.
    if (result.ok || result.failure.error === "allergen_not_found") {
      onDeleted();
      return;
    }
    setError(deleteRefusal(result.failure));
    busy.current = false;
    setPending(false);
  }

  return (
    <section aria-labelledby="delete-heading" className={styles.danger}>
      <h2 id="delete-heading">Delete allergen</h2>
      <p>
        Deleting removes the entry and its matches from every food. It is refused while any member
        avoids this allergen.
      </p>
      {open ? (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {error ? (
            <p role="alert" className="form-error" data-testid="delete-error">
              {error}
            </p>
          ) : null}
          <Field
            name="confirm-key"
            label={`Type the key (${allergen.key}) to confirm`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.deleteButton}
              disabled={!confirmed || pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Deleting…" : `Delete ${allergen.displayName} permanently`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Delete allergen…
        </button>
      )}
    </section>
  );
}
