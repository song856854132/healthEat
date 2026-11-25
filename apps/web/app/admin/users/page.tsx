import type { Metadata } from "next";
import { APP_NAME } from "@healtheat/shared";
import { readUsersQuery } from "../../lib/admin";
import { UserList } from "./user-list";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata: Metadata = {
  title: `Users · ${APP_NAME}`,
  description: "Accounts: filter by username, email, role and status.",
};

/**
 * /admin/users?q=&role=&status=&page= (design doc, Pages table: account management, the Admin's view;
 * anonymous visitors log in first). The URL is the whole state, so a filtered list is a link.
 */
export default async function UsersPage({ searchParams }: Props) {
  const query = readUsersQuery(await searchParams);
  // Keyed on the URL: Back and Forward show that list's own filters and page.
  const key = `${query.q}|${query.role ?? ""}|${query.status ?? ""}|${query.page}`;
  return <UserList key={key} query={query} />;
}
