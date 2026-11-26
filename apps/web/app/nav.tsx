"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { APP_NAME } from "@healtheat/shared";
import type { MeResponse, Role } from "@healtheat/shared";
import { useAuth } from "./auth-context";
import { ROLE_LABELS, orderedRoles, setActiveRole } from "./lib/roles";

/** The links of the active view (Home wireframe: each role's nav). Every view keeps Home and Profile. */
function ViewLinks({ me }: { me: MeResponse }) {
  const { activeRole, roles } = me.user;
  if (activeRole === "curator" && roles.includes("curator"))
    return (
      <Link href="/curate/allergens" data-testid="nav-dictionary">
        Dictionary
      </Link>
    );
  if (activeRole === "admin" && roles.includes("admin"))
    return (
      <Link href="/admin/users" data-testid="nav-users">
        Users
      </Link>
    );
  return (
    <Link href="/log" data-testid="nav-day-log">
      Day log
    </Link>
  );
}

/**
 * The active role (design doc R3-7): a badge for a member-only account, and a "View as" switch for an
 * account holding more roles. Choosing a view only picks it; Switch calls PUT /api/users/me/active-role
 * and opens that view's Home. (A select that switched on change would leave the page while a keyboard
 * user arrows through the options: WCAG 3.2.2.)
 */
function RoleSwitch({ me }: { me: MeResponse }) {
  const { setMe } = useAuth();
  const router = useRouter();
  const active = me.user.activeRole;
  const [choice, setChoice] = useState<Role>(active);
  const [shownFor, setShownFor] = useState<Role>(active);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = orderedRoles(me.user.roles);
  // The view changed elsewhere (another tab, a recheck), or the chosen role was revoked meanwhile: the
  // choice follows the active view, so the select never shows one role while Switch would send another.
  if (shownFor !== active || !roles.includes(choice)) {
    setShownFor(active);
    setChoice(active);
  }

  if (roles.length < 2)
    return (
      <span data-testid="nav-role" className="role-badge">
        {ROLE_LABELS[active]}
      </span>
    );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || choice === active) return;
    setPending(true);
    setError(null);
    try {
      const result = await setActiveRole(choice);
      if (result.ok) {
        setMe(result.data);
        router.push("/");
      } else {
        setError(result.failure.message);
        setChoice(active);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className="role-switch" onSubmit={onSubmit} aria-label="View as">
        <label htmlFor="nav-view">View as</label>
        <select
          id="nav-view"
          data-testid="nav-view"
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value as Role);
            setError(null);
          }}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          data-testid="nav-view-switch"
          disabled={pending || choice === active}
          aria-busy={pending || undefined}
        >
          {pending ? "Switching…" : "Switch"}
        </button>
      </form>
      {error ? (
        <span data-testid="nav-view-error" className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function Nav() {
  const { me, checkFailed, recheck, logout } = useAuth();
  const router = useRouter();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onLogout() {
    setPending(true);
    setLogoutError(null);
    try {
      const result = await logout();
      if (result.ok) router.push("/");
      else setLogoutError(result.message); // the server session is still live; keep showing it
    } finally {
      setPending(false);
    }
  }

  return (
    <header className="site-header">
      <nav aria-label="Main" className="site-nav">
        <Link href="/" className="brand">
          {APP_NAME}
        </Link>
        <div className="nav-session" aria-live="polite">
          {me === undefined ? (
            // Not known yet. After a failed check (5xx, offline) say so instead of showing the
            // signed-out links: the session may well still be live.
            checkFailed ? (
              <>
                <span data-testid="nav-error" className="field-error">
                  Could not check your session.
                </span>
                <button type="button" onClick={() => void recheck()}>
                  Retry
                </button>
              </>
            ) : null
          ) : me ? (
            <>
              <ViewLinks me={me} />
              <Link href="/profile" data-testid="nav-username" className="nav-user">
                {me.user.username}
              </Link>
              <RoleSwitch me={me} />
              <button
                type="button"
                onClick={onLogout}
                disabled={pending}
                aria-busy={pending || undefined}
              >
                Log out
              </button>
              {logoutError ? (
                <span data-testid="nav-error" className="field-error">
                  {logoutError}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/register" className="button-link">
                Register
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
