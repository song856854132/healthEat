import { HomeView } from "./home-view";
import { Spike } from "./spike";

// Home (T30; restyled to the v2 UI design, T32): the view depends on the session, so it renders in
// the browser (home-view.tsx), which also owns the page's <main> and its h1. The About and Privacy
// policy links are in the footer of every page (layout.tsx, T12).
export default function Home() {
  return (
    <HomeView>
      {/* T1 proxy spike: its acceptance test (e2e/spike.spec.ts) runs against Home. */}
      <Spike />
    </HomeView>
  );
}
