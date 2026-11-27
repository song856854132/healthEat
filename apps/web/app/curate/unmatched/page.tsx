import type { Metadata } from "next";
import { APP_NAME } from "@healtheat/shared";
import { readUnmatchedQuery } from "../../lib/curate";
import { UnmatchedQueue } from "./unmatched-queue";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata: Metadata = {
  title: `Unmatched ingredients · ${APP_NAME}`,
  description:
    "Ingredient phrases from cached USDA foods that matched no allergen synonym: map each to an allergen or ignore it.",
};

/**
 * /curate/unmatched?status=&page= (design doc, Pages table, phase 3: the unmatched ingredient queue,
 * the Curator's view; anonymous visitors log in first). The URL is the whole state, so a list is a link.
 */
export default async function UnmatchedPage({ searchParams }: Props) {
  const query = readUnmatchedQuery(await searchParams);
  // Keyed on the URL: Back and Forward show that list's own status and page.
  return <UnmatchedQueue key={`${query.status}|${query.page}`} query={query} />;
}
