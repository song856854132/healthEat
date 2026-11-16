"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { APP_NAME } from "@healtheat/shared";
import { useAuth } from "./auth-context";

const ROLE_LABELS = { member: "Member", curator: "Curator", admin: "Admin" } as const;

export function Nav() {
  const { me, logout } = useAuth();
  const router = useRouter();

  async function onLogout() {
    await logout();
    router.push("/");
  }

  return (
    <header className="site-header">
      <nav aria-label="Main" className="site-nav">
        <Link href="/" className="brand">
          {APP_NAME}
        </Link>
        <div className="nav-session" aria-live="polite">
          {me === undefined ? null : me ? (
            <>
              <span data-testid="nav-username" className="nav-user">
                {me.user.username}
              </span>
              <span data-testid="nav-role" className="role-badge">
                {ROLE_LABELS[me.user.activeRole]}
              </span>
              <button type="button" onClick={onLogout}>
                Log out
              </button>
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
