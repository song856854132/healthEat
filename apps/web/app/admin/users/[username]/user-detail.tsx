"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AdminUserDetail, Role } from "@healtheat/shared";
import { useAuth } from "../../../auth-context";
import { Field } from "../../../field";
import { RoleGate } from "../../../role-gate";
import { deleteUser, getUser, setRoles, setStatus } from "../../../lib/admin";
import { formatDay } from "../../../lib/home";
import { ROLE_LABELS, orderedRoles } from "../../../lib/roles";
import { LoadError, useLoad } from "../../../use-load";
import styles from "../../../manage.module.css";

// One account as an Admin manages it (design doc, Pages table; D18): its account fields and which role
// profiles exist (never logs), Curator and Admin grants, suspend or reactivate, and delete with the same
// cascade as a self-delete. The API refuses an Admin's own suspension, deletion and Admin revoke, and
// any change that would leave no usable Admin; the page says why rather than hiding the controls.

const GRANTABLE: Role[] = ["curator", "admin"];

export function UserDetail({ username }: { username: string }) {
  return (
    <RoleGate role="admin" title={username}>
      {(me) => <Account username={username} self={me.user.username === username} />}
    </RoleGate>
  );
}

function Account({ username, self }: { username: string; self: boolean }) {
  const [load, retry] = useLoad((signal) => getUser(username, signal), username);
  // The account as the last write answered it; the loaded copy until then.
  const [written, setWritten] = useState<AdminUserDetail | null>(null);
  const [deleted, setDeleted] = useState(false);
  const detail = written ?? (load.kind === "done" ? load.data : null);

  if (deleted)
    return (
      <main className={styles.view}>
        <h1>Account deleted</h1>
        <p role="status" data-testid="user-deleted">
          {username}’s account, profiles, logs and allergen settings have been deleted, and its
          sessions ended.
        </p>
        <p>
          <Link href="/admin/users">Back to Users</Link>
        </p>
      </main>
    );

  return (
    <main className={styles.view}>
      <p>
        <Link href="/admin/users">← Users</Link>
      </p>
      <h1>{username}</h1>
      {detail ? (
        <>
          <Facts detail={detail} self={self} />
          <Roles detail={detail} self={self} onWritten={setWritten} />
          <Status detail={detail} self={self} onWritten={setWritten} />
          <Delete username={username} self={self} onDeleted={() => setDeleted(true)} />
        </>
      ) : load.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading…
        </p>
      ) : load.kind === "error" && load.failure.error === "not_found" ? (
        <p data-testid="user-missing">
          There is no account named <strong>{username}</strong>; it may have been deleted.{" "}
          <Link href="/admin/users">Back to Users</Link>
        </p>
      ) : load.kind === "error" ? (
        <LoadError failure={load.failure} retry={retry} testId="user-error" />
      ) : null}
    </main>
  );
}

function Facts({ detail, self }: { detail: AdminUserDetail; self: boolean }) {
  const { user, profiles } = detail;
  const held = orderedRoles(user.roles);
  return (
    <section aria-labelledby="account-heading" data-testid="user-facts">
      <h2 id="account-heading">Account{self ? " (you)" : ""}</h2>
      <dl className={styles.facts}>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Roles</dt>
        <dd data-testid="user-roles">{held.map((r) => ROLE_LABELS[r]).join(", ")}</dd>
        <dt>Viewing as</dt>
        <dd>{ROLE_LABELS[user.activeRole]}</dd>
        <dt>Status</dt>
        <dd data-testid="user-status">
          {user.status === "active" ? "Active" : "Suspended"}
          {user.deletionPending ? " · deletion pending (finishes at its next login or delete)" : ""}
        </dd>
        <dt>Joined</dt>
        <dd>
          <time dateTime={user.createdAt}>{formatDay(user.createdAt)}</time>
        </dd>
        <dt>Privacy notice</dt>
        <dd>
          {user.privacyAckAt ? (
            <>
              acknowledged <time dateTime={user.privacyAckAt}>{formatDay(user.privacyAckAt)}</time>
            </>
          ) : (
            "not acknowledged"
          )}
        </dd>
        <dt>Profiles</dt>
        <dd>
          {(Object.keys(profiles) as Role[])
            .filter((k) => profiles[k])
            .map((k) => ROLE_LABELS[k])
            .join(", ") || "none"}
        </dd>
      </dl>
      <p className={styles.note}>
        The username never changes. Admins see account fields only, never logs or allergen settings.
      </p>
    </section>
  );
}

const ROLES_MOVED =
  "Another Admin changed this account's roles since you opened it. Nothing was saved; the roles below are as stored now. Make your change again.";

const sameRoles = (a: readonly Role[], b: readonly Role[]) =>
  orderedRoles(a).join() === orderedRoles(b).join();

/**
 * Grant or revoke Curator and Admin; Member is implicit for every account (RoleUpdateInput). The PUT
 * replaces the whole role set, and the API only catches a change made during its own request, so the
 * page reads the account again first: a role another Admin granted or revoked after this page loaded is
 * never silently undone.
 */
function Roles({
  detail,
  self,
  onWritten,
}: {
  detail: AdminUserDetail;
  self: boolean;
  onWritten: (d: AdminUserDetail) => void;
}) {
  const { recheck } = useAuth();
  const [chosen, setChosen] = useState<Set<Role>>(() => new Set(detail.user.roles));
  // The stored roles the checkboxes were set from: a newer copy (from a status write, or a refused save)
  // resets them, so the boxes never offer to undo a change they did not show.
  const [seededFrom, setSeededFrom] = useState(detail.user.roles);
  if (!sameRoles(seededFrom, detail.user.roles)) {
    setSeededFrom(detail.user.roles);
    setChosen(new Set(detail.user.roles));
  }
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const held = new Set(detail.user.roles);
  const changed = GRANTABLE.some((r) => chosen.has(r) !== held.has(r));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current || !changed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const fresh = await getUser(detail.user.username);
      if (!fresh.ok) {
        setError(fresh.failure.message);
        return;
      }
      if (!sameRoles(fresh.data.user.roles, detail.user.roles)) {
        onWritten(fresh.data);
        setError(ROLES_MOVED);
        return;
      }
      const result = await setRoles(detail.user.username, orderedRoles(["member", ...chosen]));
      if (result.ok) {
        onWritten(result.data);
        setChosen(new Set(result.data.user.roles));
        setSaved(true);
        // Your own roles changed: the nav's view switch must follow.
        if (self) void recheck();
      } else setError(result.failure.message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="roles-heading" data-testid="user-role-form">
      <h2 id="roles-heading">Roles</h2>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <fieldset disabled={pending} className={styles.fieldset}>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <label className={styles.check}>
            <input type="checkbox" checked disabled />
            <span>Member: every account; logs meals and sees its own week</span>
          </label>
          {GRANTABLE.map((r) => {
            const ownAdmin = self && r === "admin";
            return (
              <label key={r} className={styles.check}>
                <input
                  type="checkbox"
                  name={r}
                  checked={chosen.has(r)}
                  disabled={ownAdmin}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(r);
                    else next.delete(r);
                    setChosen(next);
                    setSaved(false);
                  }}
                />
                <span>
                  {r === "curator"
                    ? "Curator: edits the allergen dictionary"
                    : "Admin: manages accounts"}
                  {ownAdmin ? " (you cannot remove Admin from your own account)" : ""}
                </span>
              </label>
            );
          })}
          <div className={styles.actions}>
            <button
              type="submit"
              className="primary"
              disabled={pending || !changed}
              aria-busy={pending || undefined}
            >
              {pending ? "Saving…" : "Save roles"}
            </button>
            {saved ? (
              <span role="status" className="hint">
                Roles saved.
              </span>
            ) : null}
          </div>
        </fieldset>
      </form>
      <p className={styles.note}>
        A revoked role keeps its profile; if it was the account’s view, the account goes back to the
        Member view.
      </p>
    </section>
  );
}

/** Suspend (the account's sessions end at once and it cannot log in) or reactivate. */
function Status({
  detail,
  self,
  onWritten,
}: {
  detail: AdminUserDetail;
  self: boolean;
  onWritten: (d: AdminUserDetail) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const suspended = detail.user.status === "suspended";

  async function onClick() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setStatus(detail.user.username, suspended ? "active" : "suspended");
      if (result.ok) onWritten(result.data);
      else setError(result.failure.message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="status-heading" data-testid="user-status-form">
      <h2 id="status-heading">Status</h2>
      <p>
        {suspended
          ? "This account is suspended: it cannot log in. Reactivating lets it log in again."
          : "Suspending ends this account’s sessions at once and stops it logging in, until reactivated."}
      </p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={pending || (self && !suspended)}
          aria-busy={pending || undefined}
        >
          {pending ? "Saving…" : suspended ? "Reactivate account" : "Suspend account"}
        </button>
        {self && !suspended ? (
          <span className="hint">You cannot suspend your own account.</span>
        ) : null}
      </div>
    </section>
  );
}

/** Delete with confirmation: typing the username arms the button; the same cascade as a self-delete. */
function Delete({
  username,
  self,
  onDeleted,
}: {
  username: string;
  self: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const confirmed = typed.trim().toLowerCase() === username;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current || !confirmed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await deleteUser(username);
    // A 404 means another Admin deleted it first: the account is gone either way.
    if (result.ok || result.failure.error === "not_found") {
      onDeleted();
      return;
    }
    setError(result.failure.message);
    busy.current = false;
    setPending(false);
  }

  return (
    <section aria-labelledby="delete-heading" className={styles.danger}>
      <h2 id="delete-heading">Delete account</h2>
      {self ? (
        <p>
          You cannot delete your own account here. Use{" "}
          <Link href="/profile">Delete account on your profile</Link> instead.
        </p>
      ) : (
        <>
          <p>
            Deleting removes the account, all its profiles, every food log entry and its allergen
            settings, and ends its sessions. It cannot be undone.
          </p>
          {open ? (
            <form className={styles.form} onSubmit={onSubmit} noValidate>
              {error ? (
                <p role="alert" className="form-error">
                  {error}
                </p>
              ) : null}
              <Field
                name="confirm-username"
                label={`Type the username (${username}) to confirm`}
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
                  {pending ? "Deleting…" : `Delete ${username} permanently`}
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
        </>
      )}
    </section>
  );
}
