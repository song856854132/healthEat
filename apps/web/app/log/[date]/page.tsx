import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LogDate } from "@healtheat/shared";
import { formatLogDate } from "../../lib/logs";
import { DayLog } from "./day-log";

type Props = { params: Promise<{ date: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const parsed = LogDate.safeParse((await params).date);
  return {
    title: parsed.success ? `${formatLogDate(parsed.data)} · Day log · healthEat` : "Day log",
  };
}

/**
 * /log/[date] (design doc, Pages table: own day log, edit portions; anonymous visitors log in first).
 * The date is the whole state, so a day is a link. Anything that is not a calendar date is a 404.
 */
export default async function DayLogPage({ params }: Props) {
  const parsed = LogDate.safeParse((await params).date);
  if (!parsed.success) notFound();
  return <DayLog key={parsed.data} date={parsed.data} />;
}
