import Link from "next/link";
import { APP_NAME } from "@healtheat/shared";
import { Spike } from "./spike";

export default function Home() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p className="lede">
        A weekly nutrient-and-sensitivity coach. Calorie trackers stop at calories; this one tells
        you when your week is running low on a nutrient and tracks exposure to the ingredients your
        body reacts to.
      </p>
      <p>
        <Link href="/search">Search foods</Link> in USDA FoodData Central and see their nutrients
        and allergens.
      </p>
      <p>More is coming soon.</p>
      <Spike />
    </main>
  );
}
