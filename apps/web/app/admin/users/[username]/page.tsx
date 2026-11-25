import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME, USERNAME_PATTERN } from "@healtheat/shared";
import { UserDetail } from "./user-detail";

type Props = { params: Promise<{ username: string }> };

/** Usernames are stored lowercase; anything that cannot be one (a malformed escape too) is a 404. */
async function usernameFrom(params: Props["params"]): Promise<string | null> {
  const raw = (await params).username;
  let name: string;
  try {
    name = decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
  return USERNAME_PATTERN.test(name) ? name : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `${(await usernameFrom(params)) ?? "Account"} · Users · ${APP_NAME}` };
}

/**
 * /admin/users/[username] (design doc, Pages table: grant or revoke Curator and Admin, suspend or
 * reactivate, delete an account with the same cascade as self-delete). Account fields only, never logs.
 */
export default async function UserPage({ params }: Props) {
  const username = await usernameFrom(params);
  if (!username) notFound();
  return <UserDetail key={username} username={username} />;
}
