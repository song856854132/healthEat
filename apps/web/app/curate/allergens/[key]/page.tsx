import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME, AllergenKey } from "@healtheat/shared";
import { EditAllergen } from "../allergen-editor";

type Props = {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const parsed = AllergenKey.safeParse((await params).key);
  return { title: `${parsed.success ? parsed.data : "Allergen"} · Dictionary · ${APP_NAME}` };
}

/**
 * /curate/allergens/[key] (design doc, Pages table: per-allergen synonyms and description keywords,
 * re-match status and "Continue re-match"; state in the URL is the allergen key). A key that cannot be
 * one is a 404. `?added=1` comes from the create form and says the entry was just added.
 */
export default async function AllergenPage({ params, searchParams }: Props) {
  const parsed = AllergenKey.safeParse((await params).key);
  if (!parsed.success) notFound();
  const added = (await searchParams).added === "1";
  return <EditAllergen key={parsed.data} allergenKey={parsed.data} added={added} />;
}
