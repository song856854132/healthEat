"use client";

import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AdminProfileInput, CuratorProfileInput } from "@healtheat/shared";
import type { AdminProfileView, CuratorProfileView } from "@healtheat/shared";
import { Field, TextAreaField } from "../field";
import { getAdminProfile, updateAdminProfile } from "../lib/admin";
import { getCuratorProfile, updateCuratorProfile } from "../lib/curate";
import { formatDay } from "../lib/home";
import type { ApiResult } from "../lib/request";
import { useLoad } from "../use-load";
import styles from "./profile.module.css";

// The Curator and Admin profiles on /profile (T21; design doc, Data model: CuratorProfile `credentials`,
// `bio`, `specialties`, `publicListing`; AdminProfile `internalNote`). The counters (`editsCount`,
// `lastEditAt`, `grantsCount`, `lastAuditAt`) are written by the server and only shown here.

/** Loads a role profile and renders its form, with Try again on a failure. */
function ProfileSection<T>({
  id,
  title,
  load,
  children,
}: {
  id: string;
  title: string;
  load: (signal: AbortSignal) => Promise<ApiResult<T>>;
  children: (profile: T) => ReactNode;
}) {
  const [state, retry] = useLoad(load);
  return (
    <section aria-labelledby={`${id}-heading`} data-testid={id}>
      <h2 id={`${id}-heading`}>{title}</h2>
      {state.kind === "loading" ? <p className="hint">Loading…</p> : null}
      {state.kind === "error" ? (
        <>
          <p className="form-error">{state.failure.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </>
      ) : null}
      {state.kind === "done" ? children(state.data) : null}
    </section>
  );
}

function SaveRow({ pending, saved }: { pending: boolean; saved: boolean }) {
  return (
    <div className={styles.actions}>
      <button type="submit" className="primary" disabled={pending} aria-busy={pending || undefined}>
        {pending ? "Saving…" : "Save"}
      </button>
      {saved ? (
        <span role="status" className="hint">
          Saved.
        </span>
      ) : null}
    </div>
  );
}

// ---- Curator -------------------------------------------------------------------------------------

export function CuratorProfileSection() {
  return (
    <ProfileSection id="curator-profile" title="Curator profile" load={getCuratorProfile}>
      {(profile) => <CuratorForm initial={profile} />}
    </ProfileSection>
  );
}

const textOrNull = (s: string) => (s.trim() === "" ? null : s.trim());

function CuratorForm({ initial }: { initial: CuratorProfileView }) {
  const [profile, setProfile] = useState(initial);
  const [credentials, setCredentials] = useState(initial.credentials ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  const [specialties, setSpecialties] = useState(initial.specialties.join(", "));
  const [publicListing, setPublicListing] = useState(initial.publicListing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const edited =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setSaved(false);
    };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(false);
    const parsed = CuratorProfileInput.safeParse({
      credentials: textOrNull(credentials),
      bio: textOrNull(bio),
      specialties: specialties
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      publicListing,
    });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        found[key] ??=
          key === "specialties" && issue.code === "too_big"
            ? issue.path.length > 1
              ? "Each specialty is at most 40 characters."
              : "At most 20 specialties."
            : issue.message;
      }
      setErrors(found);
      return;
    }
    busy.current = true;
    setPending(true);
    setErrors({});
    try {
      const result = await updateCuratorProfile(parsed.data);
      if (result.ok) {
        setProfile(result.data);
        setSpecialties(result.data.specialties.join(", "));
        setSaved(true);
      } else setErrors({ form: result.failure.message });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <p className="hint" data-testid="curator-counters">
        {profile.editsCount} dictionary edit{profile.editsCount === 1 ? "" : "s"}
        {profile.lastEditAt ? `, the last on ${formatDay(profile.lastEditAt)}` : ""}.
      </p>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <fieldset disabled={pending} className={styles.fieldset}>
          {errors.form ? (
            <p role="alert" className="form-error">
              {errors.form}
            </p>
          ) : null}
          <Field
            name="credentials"
            label="Credentials (optional)"
            value={credentials}
            onChange={(e) => edited(setCredentials)(e.target.value)}
            hint="For example RD, MS Nutrition. Shown on your public profile."
            error={errors.credentials}
          />
          <TextAreaField
            name="bio"
            label="Bio (optional)"
            rows={4}
            value={bio}
            onChange={(e) => edited(setBio)(e.target.value)}
            error={errors.bio}
          />
          <Field
            name="specialties"
            label="Specialties (optional)"
            value={specialties}
            onChange={(e) => edited(setSpecialties)(e.target.value)}
            hint="Separated by commas, for example dairy, FODMAP."
            error={errors.specialties}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              name="publicListing"
              checked={publicListing}
              onChange={(e) => edited(setPublicListing)(e.target.checked)}
            />
            <span>List me among the newest public profiles on Home</span>
          </label>
          <SaveRow pending={pending} saved={saved} />
        </fieldset>
      </form>
    </>
  );
}

// ---- Admin ---------------------------------------------------------------------------------------

export function AdminProfileSection() {
  return (
    <ProfileSection id="admin-profile" title="Admin profile" load={getAdminProfile}>
      {(profile) => <AdminForm initial={profile} />}
    </ProfileSection>
  );
}

function AdminForm({ initial }: { initial: AdminProfileView }) {
  const [profile, setProfile] = useState(initial);
  const [note, setNote] = useState(initial.internalNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(false);
    const parsed = AdminProfileInput.safeParse({ internalNote: textOrNull(note) });
    if (!parsed.success) {
      setError("The note is at most 2,000 characters.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await updateAdminProfile(parsed.data);
      if (result.ok) {
        setProfile(result.data);
        setSaved(true);
      } else setError(result.failure.message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <p className="hint" data-testid="admin-counters">
        {profile.grantsCount} account change{profile.grantsCount === 1 ? "" : "s"}
        {profile.lastAuditAt ? `, the last on ${formatDay(profile.lastAuditAt)}` : ""}.
      </p>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <fieldset disabled={pending} className={styles.fieldset}>
          <TextAreaField
            name="internalNote"
            label="Private note (optional)"
            rows={3}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
            hint="Only you see this."
            error={error ?? undefined}
          />
          <SaveRow pending={pending} saved={saved} />
        </fieldset>
      </form>
    </>
  );
}
