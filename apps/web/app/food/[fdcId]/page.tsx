import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FdcIdParam } from "@healtheat/shared";
import { readLogDate } from "../../lib/foods";
import styles from "../../foods.module.css";
import { FoodView } from "./food-view";

type Props = {
  params: Promise<{ fdcId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Food details · healthEat" };

/**
 * /food/[fdcId] (design doc, Pages table: Details). The id is the USDA FoodData Central id, so the
 * URL names the food on its own; anything that is not a positive integer is a 404 without an API call.
 * `?date=YYYY-MM-DD` (from a day log's "Add food") makes "Log this" log to that day.
 */
export default async function FoodPage({ params, searchParams }: Props) {
  const { fdcId } = await params;
  const date = readLogDate((await searchParams).date);
  const parsed = /^\d+$/.test(fdcId) ? FdcIdParam.safeParse(fdcId) : null;
  if (!parsed?.success) notFound();
  return (
    <main className={styles.wide}>
      <FoodView fdcId={parsed.data} date={date} />
    </main>
  );
}
