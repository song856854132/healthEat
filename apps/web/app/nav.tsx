"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
 * account holding more roles. Switching calls PUT /api/users/me/active-role and opens that view's Home.
 */
function RoleSwitch({ me }: { me: MeResponse }) {
  const { setMe } = useAuth();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = orderedRoles(me.user.roles);

  if (roles.length < 2)
    return (
      <span data-testid="nav-role" className="role-badge">
        {ROLE_LABELS[me.user.activeRole]}
      </span>
    );

  async function onChange(role: Role) {
    setPending(true);
    setError(null);
    try {
      const result = await setActiveRole(role);
      if (result.ok) {
        setMe(result.data);
        router.push("/");
      } else setError(result.failure.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <label className="role-switch">
        <span>View as</span>
        <select
          data-testid="nav-view"
          value={me.user.activeRole}
          disabled={pending}
          aria-busy={pending || undefined}
          onChange={(e) => void onChange(e.target.value as Role)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
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
