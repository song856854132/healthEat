"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { ACCOUNT_STATUSES, ROLES } from "@healtheat/shared";
import type { AccountStatus, AdminUserListResponse, Role } from "@healtheat/shared";
import { RoleGate } from "../../role-gate";
import { listUsers, userHref, usersHref } from "../../lib/admin";
import type { UsersQuery } from "../../lib/admin";
import { formatDay } from "../../lib/home";
import { ROLE_LABELS, orderedRoles } from "../../lib/roles";
import { LoadError, useLoad } from "../../use-load";
import styles from "../../manage.module.css";

/** Every account, 20 a page by username, filtered by a username or email prefix, a role and a status. */
export function UserList({ query }: { query: UsersQuery }) {
  return (
    <RoleGate role="admin" title="Users">
      {(me) => <Users query={query} self={me.user.username} />}
    </RoleGate>
  );
}

function Users({ query, self }: { query: UsersQuery; self: string }) {
  const [users, retry] = useLoad((signal) => listUsers(query, signal), usersHref(query));
  return (
    <main className={`${styles.wide} ${styles.view}`}>
      <h1>Users</h1>
      <p className="lede">
        Account fields only: username, email, roles, status and dates. Admins never see logs or the
        dictionary.
      </p>
      <Filters query={query} />
      {users.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading accounts…
        </p>
      ) : users.kind === "error" ? (
        <LoadError failure={users.failure} retry={retry} testId="users-error" />
      ) : (
        <Results data={users.data} query={query} self={self} />
      )}
    </main>
  );
}

function Filters({ query }: { query: UsersQuery }) {
  const router = useRouter();
  const [q, setQ] = useState(query.q);
  const [role, setRole] = useState<Role | "">(query.role ?? "");
  const [status, setStatus] = useState<AccountStatus | "">(query.status ?? "");
  const filtered = Boolean(query.q || query.role || query.status);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    router.push(
      usersHref({
        q: q.trim().toLowerCase(),
        role: role || undefined,
        status: status || undefined,
        page: 1,
      }),
    );
  }

  return (
    <form className={styles.filters} onSubmit={onSubmit} role="search" aria-label="Filter accounts">
      <label>
        Username or email starts with
        <input
          type="search"
          name="q"
          value={q}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <label>
        Role
        <select name="role" value={role} onChange={(e) => setRole(e.target.value as Role | "")}>
          <option value="">Any role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AccountStatus | "")}
        >
          <option value="">Any status</option>
          {ACCOUNT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "active" ? "Active" : "Suspended"}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Filter</button>
      {filtered ? <Link href="/admin/users">Clear filters</Link> : null}
    </form>
  );
}

function Results({
  data,
  query,
  self,
}: {
  data: AdminUserListResponse;
  query: UsersQuery;
  self: string;
}) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <section aria-labelledby="results-heading" data-testid="users-results">
      <h2 id="results-heading">
        {data.total} account{data.total === 1 ? "" : "s"}
        {query.q || query.role || query.status ? (data.total === 1 ? " matches" : " match") : ""}
      </h2>
      {data.users.length === 0 ? (
        <p className={styles.muted} data-testid="users-empty">
          {data.total > 0 ? "No accounts on this page." : "No accounts match these filters."}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Email</th>
                <th scope="col">Roles</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.username} data-testid="user-row">
                  <th scope="row">
                    <Link href={userHref(u.username)}>{u.username}</Link>
                    {u.username === self ? <span className={styles.muted}> (you)</span> : null}
                  </th>
                  <td className={styles.phrases}>{u.email}</td>
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
                      <span className={`${styles.chip} ${styles.chipWarn}`}>deletion pending</span>
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
      {pages > 1 || query.page > 1 ? (
        <nav className={styles.pager} aria-label="Pages">
          {query.page > 1 ? (
            <Link href={usersHref({ ...query, page: query.page - 1 })} rel="prev">
              ← Previous
            </Link>
          ) : null}
          <span data-testid="users-page">
            Page {query.page} of {pages}
          </span>
          {query.page < pages ? (
            <Link href={usersHref({ ...query, page: query.page + 1 })} rel="next">
              Next →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
