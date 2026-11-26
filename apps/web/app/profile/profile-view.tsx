"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MemberProfileInput } from "@healtheat/shared";
import type { MeResponse, MemberProfileView } from "@healtheat/shared";
import { useAuth } from "../auth-context";
import { Field } from "../field";
import { deleteAccount, getMemberProfile, updateMemberProfile } from "../lib/account";
import { firstPerField } from "../lib/form";
import { ROLE_LABELS, orderedRoles } from "../lib/roles";
import { AdminProfileSection, CuratorProfileSection } from "./role-profiles";
import { confirmSession } from "./session";
import { AllergenSettingsSection } from "./allergen-settings";
import { BodySection } from "./body-section";
import styles from "./profile.module.css";

export function ProfileView() {
  const { me, checkFailed, clear } = useAuth();
  const router = useRouter();
  const [deleted, setDeleted] = useState(false);

  // Anonymous visitors log in first (Pages table: "redirect to login"). Not after a deletion: the
  // page says the account is gone instead.
  useEffect(() => {
    if (me === null && !deleted) router.replace("/login");
  }, [me, deleted, router]);

  if (deleted) {
    return (
      <main>
        <h1>Account deleted</h1>
        <p role="status">
          Your account and everything in it have been deleted, and you are signed out.
        </p>
        <p>
          <Link href="/">Back to Home</Link>
        </p>
      </main>
    );
  }

  if (!me) {
    return (
      <main>
        <h1>Your profile</h1>
        <p className="hint">
          {me === null
            ? "Log in to see your profile. Taking you to the login page…"
            : checkFailed
              ? "Could not check your session. Use Retry at the top of the page."
              : "Loading…"}
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Your profile</h1>
      <AccountSection me={me} />
      <BodySection key={`body|${me.user.username}`} username={me.user.username} />
      <AllergenSettingsSection key={`allergens|${me.user.username}`} username={me.user.username} />
      <SharingSection key={`sharing|${me.user.username}`} username={me.user.username} />
      {me.user.roles.includes("curator") ? (
        <CuratorProfileSection key={`curator|${me.user.username}`} username={me.user.username} />
      ) : null}
      {me.user.roles.includes("admin") ? (
        <AdminProfileSection key={`admin|${me.user.username}`} username={me.user.username} />
      ) : null}
      <DeleteSection
        key={`delete|${me.user.username}`}
        username={me.user.username}
        onDeleted={() => {
          setDeleted(true);
          clear();
        }}
      />
    </main>
  );
}

function AccountSection({ me }: { me: MeResponse }) {
  const since = new Date(me.user.createdAt);
  return (
    <section aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>
      <dl className={styles.facts}>
        <dt>Username</dt>
        <dd data-testid="profile-username">{me.user.username}</dd>
        <dt>Email</dt>
        <dd>{me.user.email}</dd>
        <dt>Roles</dt>
        <dd>
          {orderedRoles(me.user.roles)
            .map((r) => ROLE_LABELS[r])
            .join(", ")}
        </dd>
        <dt>Member since</dt>
        <dd>
          <time dateTime={me.user.createdAt}>
            {since.toLocaleDateString("en-US", { dateStyle: "long" })}
          </time>
        </dd>
      </dl>
      <p className="hint">Your username cannot be changed. Other people see only your username.</p>
    </section>
  );
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; profile: MemberProfileView };

/**
 * The member profile's sharing choices and phone (design doc: MemberProfile `publicLogs`,
 * `showPhoneOnProfile`, `phone`; R3-14). The PUT sends only these three fields, so the body details
 * the summary uses are left as they are.
 */
function SharingSection({ username }: { username: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    getMemberProfile(controller.signal)
      .then((result) =>
        setLoad(
          result.ok
            ? { state: "ready", profile: result.data }
            : { state: "error", message: result.failure.message },
        ),
      )
      .catch(() => undefined); // aborted: the section unmounted
    return () => controller.abort();
  }, [attempt]);

  return (
    <section aria-labelledby="sharing-heading">
      <h2 id="sharing-heading">Sharing and contact</h2>
      {load.state === "loading" ? <p className="hint">Loading…</p> : null}
      {load.state === "error" ? (
        <>
          <p className="form-error">{load.message}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </>
      ) : null}
      {load.state === "ready" ? (
        <SharingForm
          username={username}
          profile={load.profile}
          onSaved={(profile) => setLoad({ state: "ready", profile })}
        />
      ) : null}
    </section>
  );
}

function SharingForm({
  username,
  profile,
  onSaved,
}: {
  username: string;
  profile: MemberProfileView;
  onSaved: (profile: MemberProfileView) => void;
}) {
  const [publicLogs, setPublicLogs] = useState(profile.publicLogs);
  const [showPhone, setShowPhone] = useState(profile.showPhoneOnProfile);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [errors, setErrors] = useState<{ form?: string; phone?: string }>({});
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const { recheck } = useAuth();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    setSaved(false);
    const parsed = MemberProfileInput.safeParse({
      publicLogs,
      showPhoneOnProfile: showPhone,
      phone: phone.trim() === "" ? null : phone,
    });
    if (!parsed.success) {
      const fields = firstPerField(
        parsed.error.flatten((i) =>
          i.path[0] === "phone" && i.code !== "too_big"
            ? "Use digits, spaces, brackets and dashes, with an optional leading +."
            : i.message,
        ).fieldErrors,
      );
      setErrors({ phone: fields.phone, form: fields.phone ? undefined : "Check the form." });
      return;
    }
    if (parsed.data.showPhoneOnProfile && !parsed.data.phone) {
      setErrors({ phone: "Add a phone number to show it, or untick the box." });
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
        onSaved(result.data);
        setPhone(result.data.phone ?? "");
        setSaved(true);
      } else {
        setErrors({ form: result.failure.message });
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      {/* Disabled while saving, so a change made mid-save is not followed by "Saved." without being sent. */}
      <fieldset disabled={pending} className={styles.fieldset}>
        {errors.form ? (
          <p role="alert" className="form-error">
            {errors.form}
          </p>
        ) : null}
        <label className={styles.check}>
          <input
            type="checkbox"
            name="publicLogs"
            checked={publicLogs}
            onChange={(e) => {
              setPublicLogs(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            Public logs: show my username next to foods I log (to signed-in visitors), and list me
            among the newest members on Home
          </span>
        </label>
        <Field
          name="phone"
          label="Phone number (optional)"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setSaved(false);
          }}
          hint="Private unless you choose to show it below."
          error={errors.phone}
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            name="showPhoneOnProfile"
            checked={showPhone}
            onChange={(e) => {
              setShowPhone(e.target.checked);
              setSaved(false);
            }}
          />
          <span>Show my phone number on my public profile</span>
        </label>
        <div className={styles.actions}>
          <button
            type="submit"
            className="primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Saving…" : "Save"}
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

/**
 * "Delete account" with confirmation (design doc C5, R3-11): typing the username arms the button,
 * then DELETE /api/users/me runs the T5 cascade and ends the session.
 */
function DeleteSection({ username, onDeleted }: { username: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const confirmed = typed.trim().toLowerCase() === username;
  const { recheck } = useAuth();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current || !confirmed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const switched = await confirmSession(recheck, username);
    const result = switched
      ? { ok: false as const, failure: { message: switched } }
      : await deleteAccount();
    if (result.ok) {
      onDeleted();
      return; // stays pending: the section is replaced by the "Account deleted" page
    }
    setError(result.failure.message);
    busy.current = false;
    setPending(false);
  }

  return (
    <section aria-labelledby="delete-heading" className={styles.danger}>
      <h2 id="delete-heading">Delete account</h2>
      <p>
        Deleting your account removes your account, all your profiles, every food log entry and your
        allergen settings, and signs you out everywhere. It cannot be undone.{" "}
        <Link href="/privacy#delete">What is deleted</Link>
      </p>
      {open ? (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <Field
            name="confirm-username"
            label={`Type your username (${username}) to confirm`}
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
              {pending ? "Deleting…" : "Delete my account permanently"}
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
          Delete account…
        </button>
      )}
    </section>
  );
}
