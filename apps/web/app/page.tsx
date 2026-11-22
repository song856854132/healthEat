import Link from "next/link";
import { APP_NAME } from "@healtheat/shared";
import { HomeView } from "./home-view";
import { Spike } from "./spike";
import styles from "./home.module.css";

// Home (T30): the view depends on the session, so it renders in the browser (home-view.tsx).
export default function Home() {
  return (
    <main className={styles.wide}>
      <h1>{APP_NAME}</h1>
      <HomeView />
      <p>
        <Link href="/about">About</Link> · <Link href="/privacy">Privacy policy</Link>
      </p>
      {/* T1 proxy spike: its acceptance test (e2e/spike.spec.ts) runs against Home. */}
      <Spike />
    </main>
  );
}
