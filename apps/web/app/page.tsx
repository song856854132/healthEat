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
      <p>Coming soon. The pipeline is live; the product is not yet.</p>
      <Spike />
    </main>
  );
}
