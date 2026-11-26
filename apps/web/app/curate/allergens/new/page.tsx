import type { Metadata } from "next";
import { APP_NAME } from "@healtheat/shared";
import { NewAllergen } from "../allergen-editor";

export const metadata: Metadata = { title: `Add allergen · ${APP_NAME}` };

/** /curate/allergens/new: a new dictionary entry (Curator). */
export default function NewAllergenPage() {
  return <NewAllergen />;
}
