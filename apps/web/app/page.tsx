import { APP_NAME } from "@healtheat/shared";
import { HomeView } from "./home-view";
import { Spike } from "./spike";
import styles from "./home.module.css";

// Home (T30): the view depends on the session, so it renders in the browser (home-view.tsx). The
// About and Privacy policy links are in the footer of every page (layout.tsx, T12).
export default function Home() {
  return (
    <main className={styles.wide}>
      <h1>{APP_NAME}</h1>
      <HomeView />
      {/* T1 proxy spike: its acceptance test (e2e/spike.spec.ts) runs against Home. */}
      <Spike />
    </main>
  );
}
