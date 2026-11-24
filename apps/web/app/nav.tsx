"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { APP_NAME } from "@healtheat/shared";
import { useAuth } from "./auth-context";

const ROLE_LABELS = { member: "Member", curator: "Curator", admin: "Admin" } as const;

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
              <Link href="/profile" data-testid="nav-username" className="nav-user">
                {me.user.username}
              </Link>
              <span data-testid="nav-role" className="role-badge">
                {ROLE_LABELS[me.user.activeRole]}
              </span>
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
