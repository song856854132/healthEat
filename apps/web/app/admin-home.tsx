"use client";

import Link from "next/link";
import type { AdminUserListResponse, MeResponse } from "@healtheat/shared";
import { getAdminProfile, listUsers, userHref, usersHref } from "./lib/admin";
import type { UsersQuery } from "./lib/admin";
import { formatDay } from "./lib/home";
import { ROLE_LABELS, orderedRoles } from "./lib/roles";
import type { Result } from "./lib/foods";
import { LoadError, useLoad } from "./use-load";
import styles from "./manage.module.css";

// Admin Home (T21; design doc, Pages table, Home row, and the Home wireframe's third screen): accounts.
// How many accounts hold each role and how many are suspended (each a link into the filtered list), the
// first page of the user table, and the Admin's own count of account changes. An Admin sees account
// fields only (D18): never logs, never the dictionary.

const ALL: UsersQuery = { q: "", page: 1 };
const COUNTS = [
  { id: "accounts", label: "accounts", query: ALL },
  { id: "curators", label: "Curators", query: { ...ALL, role: "curator" } },
  { id: "admins", label: "Admins", query: { ...ALL, role: "admin" } },
  { id: "suspended", label: "suspended", query: { ...ALL, status: "suspended" } },
] as const satisfies readonly { id: string; label: string; query: UsersQuery }[];

type Overview = { users: AdminUserListResponse; totals: number[] };

/** The first page of every account, plus the total behind each count (page 1 of each filter). */
async function loadOverview(signal: AbortSignal): Promise<Result<Overview>> {
  const results = await Promise.all(COUNTS.map((c) => listUsers(c.query, signal)));
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) return { ok: false, failure: failed.failure };
  const pages = results.map((r) => (r.ok ? r.data : null)).filter((p) => p !== null);
  return { ok: true, data: { users: pages[0], totals: pages.map((p) => p.total) } };
}

export function AdminHome({ me }: { me: MeResponse }) {
  const [overview, retry] = useLoad(loadOverview);
  return (
    <div className={styles.view} data-testid="admin-home">
      <p className="lede">
        Accounts on healthEat. Grant or revoke Curator and Admin, suspend or reactivate an account,
        or delete it with the same cascade as a self-delete.
      </p>
      {overview.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading accounts…
        </p>
      ) : overview.kind === "error" ? (
        <LoadError failure={overview.failure} retry={retry} testId="accounts-error" />
      ) : (
        <Accounts data={overview.data} self={me.user.username} />
      )}
      <YourChanges />
    </div>
  );
}

function Accounts({ data, self }: { data: Overview; self: string }) {
  const { users, totals } = data;
  return (
    <>
      <section aria-labelledby="counts-heading" data-testid="admin-counts">
        <h2 id="counts-heading">At a glance</h2>
        <ul className={styles.tiles}>
          {COUNTS.map((c, i) => (
            <li key={c.id} className={styles.tile} data-testid={`count-${c.id}`}>
              <strong>{totals[i]}</strong> <Link href={usersHref(c.query)}>{c.label}</Link>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="users-heading" data-testid="admin-users">
        <h2 id="users-heading">Users ({users.total})</h2>
        <p className={styles.sub}>
          Account fields only: username, email, roles, status and dates. Never logs, never the
          dictionary.
        </p>
        {users.users.length === 0 ? (
          <p className={styles.muted}>No accounts yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Username</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.users.map((u) => (
                  <tr key={u.username} data-testid="user-row">
                    <th scope="row">
                      <Link href={userHref(u.username)}>{u.username}</Link>
                      {u.username === self ? <span className={styles.muted}> (you)</span> : null}
                    </th>
                    <td>
                      {orderedRoles(u.roles).map((r) => (
                        <span key={r} className={styles.chip}>
                          {ROLE_LABELS[r]}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span
                        className={`${styles.chip} ${u.status === "suspended" ? styles.chipWarn : ""}`}
                      >
                        {u.status}
                      </span>
                      {u.deletionPending ? (
                        <span className={`${styles.chip} ${styles.chipWarn}`}>
                          deletion pending
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <time dateTime={u.createdAt}>{formatDay(u.createdAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.actions}>
          <Link href="/admin/users" className="button-link">
            {users.total > users.users.length
              ? `Search and manage all ${users.total} accounts`
              : "Search and manage accounts"}
          </Link>
        </div>
        <p className={styles.note}>
          Usernames never change. Member is implicit for everyone; Curator and Admin are granted
          here.
        </p>
      </section>
    </>
  );
}

/** The Admin's own counters (AdminProfile `grantsCount`, `lastAuditAt`; design doc, Data model). */
function YourChanges() {
  const [profile, retry] = useLoad(getAdminProfile);
  return (
    <section aria-labelledby="changes-heading" data-testid="admin-activity">
      <h2 id="changes-heading">Your changes</h2>
      {profile.kind === "loading" ? (
        <p role="status">Loading…</p>
      ) : profile.kind === "error" ? (
        <LoadError failure={profile.failure} retry={retry} testId="admin-profile-error" />
      ) : (
        <p data-testid="admin-grants">
          You have made {profile.data.grantsCount} account change
          {profile.data.grantsCount === 1 ? "" : "s"} (roles, status and deletions)
          {profile.data.lastAuditAt ? `, the last on ${formatDay(profile.data.lastAuditAt)}` : ""}.
        </p>
      )}
    </section>
  );
}
