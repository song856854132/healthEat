import type { Metadata } from "next";
import { TodayRedirect } from "./today-redirect";

export const metadata: Metadata = { title: "Day log · healthEat" };

/** /log: today's day log. "Today" is the member's time zone's, so the browser asks before going. */
export default function LogIndexPage() {
  return <TodayRedirect />;
}
