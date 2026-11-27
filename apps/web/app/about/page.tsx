import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME } from "@healtheat/shared";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: `About · ${APP_NAME}`,
  description: `What ${APP_NAME} is, who it is for, and where its food and allergen data come from.`,
};

/**
 * /about (design doc, Pages table: "Policy, attributions (USDA, Open Food Facts, Anthropic)").
 * Attribution terms follow packages/shared/data/PROVENANCE.md and fdc.nal.usda.gov ("Licensing").
 */
export default function AboutPage() {
  return (
    <main className={styles.page}>
      <h1>About {APP_NAME}</h1>
      <p className="lede">
        A weekly nutrient-and-sensitivity coach. Calorie trackers stop at calories; {APP_NAME} tells
        you when your week is running low on a nutrient, which real foods close the gap, and tracks
        your exposure to the ingredients your body reacts to.
      </p>
      <p>
        {APP_NAME} is a course final project. It is not medical advice: allergen detection is an
        estimate, so always check the package label, and talk to a clinician about allergies.
      </p>

      <h2 id="roles">Who it is for</h2>
      <ul>
        <li>
          <strong>Members</strong> search foods, log what they eat and see their week. Every account
          is a member.
        </li>
        <li>
          <strong>Curators</strong> maintain the allergen dictionary that decides which foods are
          flagged.
        </li>
        <li>
          <strong>Admins</strong> manage accounts and roles.
        </li>
      </ul>
      <p>
        There is no human coach: the coaching is the app&apos;s own summary of your logged week.
      </p>

      <h2 id="data-sources">Data sources and attributions</h2>

      <h3 id="usda">USDA FoodData Central</h3>
      <p>
        Every nutrient value and serving size in {APP_NAME} comes from{" "}
        <a href="https://fdc.nal.usda.gov/">USDA FoodData Central</a>, fetched live and cached. No
        value is estimated by a model. FoodData Central data are in the public domain and published
        under <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0 Universal</a>.
        Source citation, as USDA suggests:
      </p>
      <p className={styles.citation}>
        U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition
        Research Center. FoodData Central. [Internet]. Available from{" "}
        <a href="https://fdc.nal.usda.gov/">https://fdc.nal.usda.gov/</a>.
      </p>
      <p>{APP_NAME} is not affiliated with or endorsed by the U.S. Department of Agriculture.</p>

      <h3 id="allergens">Allergen dictionary</h3>
      <p>
        The allergen dictionary was written for {APP_NAME}. It lists the 14 allergens that
        Regulation (EU) No 1169/2011, Annex II, requires food labels to declare, plus three
        sensitivities: lactose, histamine-rich foods and high-FODMAP foods. Curators extend it with
        synonyms and keywords. A match in a food&apos;s name rather than its ingredient list is
        labelled a food-category estimate.
      </p>

      <h3 id="open-food-facts">Open Food Facts</h3>
      <p>
        We checked our dictionary against the{" "}
        <a href="https://world.openfoodfacts.org/">Open Food Facts</a> allergens taxonomy to make
        sure it covers the same 14 allergens. No Open Food Facts data or taxonomy entries are
        included in {APP_NAME}.
      </p>

      <h3 id="anthropic">Anthropic</h3>
      <p>
        Photo logging (Log by photo on the day log and on Home) uses Claude, a model by{" "}
        <a href="https://www.anthropic.com/">Anthropic</a>, to recognise the foods in a meal photo
        and suggest a search and a portion for each. You confirm every item before it is logged, and
        nutrient values still come from USDA. Photos are not stored by {APP_NAME}; see the{" "}
        <Link href="/privacy#third-parties">privacy policy</Link>.
      </p>

      <p className={styles.related}>
        <Link href="/privacy">Privacy policy</Link> · <Link href="/">Home</Link>
      </p>
    </main>
  );
}
