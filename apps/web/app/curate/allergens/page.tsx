import type { Metadata } from "next";
import { APP_NAME } from "@healtheat/shared";
import { AllergenList } from "./allergen-list";

export const metadata: Metadata = {
  title: `Allergen dictionary · ${APP_NAME}`,
  description: "The allergens, their synonyms and description keywords, and re-match status.",
};

/**
 * /curate/allergens (design doc, Pages table: Dictionary CRUD, the Curator's view; anonymous visitors
 * log in first). The account is only known in the browser, so the page is a client view.
 */
export default function AllergensPage() {
  return <AllergenList />;
}
