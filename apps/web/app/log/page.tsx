import type { Metadata } from "next";
import { TodayRedirect } from "./today-redirect";

export const metadata: Metadata = { title: "Day log · healthEat" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /log: today's day log. "Today" is the member's time zone's, so the browser asks before going.
 * /log?photo=1 (Home's "Log by photo") opens today's log with the photo panel.
 */
export default async function LogIndexPage({ searchParams }: Props) {
  const photo = (await searchParams).photo === "1";
  return <TodayRedirect photo={photo} />;
}
