"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import type { MeResponse } from "@healtheat/shared";
import { useAuth } from "./auth-context";

const WHO = { curator: "Curators", admin: "Admins" } as const;

/**
 * The Curator and Admin pages (design doc, Pages table): anonymous visitors log in first ("redirect"),
 * and an account without the role is told the page is not for it. The check is the account's roles,
 * not its active role, like the API's `requireRole`; the API refuses the calls either way.
 */
export function RoleGate({
  role,
  title,
  children,
}: {
  role: keyof typeof WHO;
  title: string;
  children: (me: MeResponse) => ReactNode;
}) {
  const { me, checkFailed } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (me === null) router.replace("/login");
  }, [me, router]);

  if (me && me.user.roles.includes(role)) return children(me);
  return (
    <main>
      <h1>{title}</h1>
      {me ? (
        <p data-testid="role-required">
          This page is for {WHO[role]}, and your account is not one.{" "}
          <Link href="/">Back to Home</Link>
        </p>
      ) : (
        <p className="hint">
          {me === null
            ? "Log in to open this page. Taking you to the login page…"
            : checkFailed
              ? "Could not check your session. Use Retry at the top of the page."
              : "Loading…"}
        </p>
      )}
    </main>
  );
}
