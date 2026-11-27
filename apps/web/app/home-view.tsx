"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import type {
  CalorieMeter as Meter,
  GapFoodsResponse,
  NutrientBand,
  PublicHomeResponse,
  SummaryResponse,
} from "@healtheat/shared";
import { NutrientBands } from "../components/NutrientBand";
import { useAuth } from "./auth-context";
import { searchHref } from "./lib/foods";
import { getGapFoods, getPublicHome, getSummary, nutrientIdFor, shortDate } from "./lib/home";
import { EXAMPLE_WEEK } from "./lib/example-week";
import { formatAmount } from "./lib/nutrients";
import { AdminHome } from "./admin-home";
import { CuratorHome } from "./curator-home";
import { LoadError, useLoad } from "./use-load";
import styles from "./home.module.css";

// Home (T30; design doc, Pages table and the Home wireframe). Anonymous visitors get the live public
// feed, one labelled example band and a way in; a signed-in account gets Member Home in the wireframe's
// order: alert strip, today's calorie meter, the 7-day bands, exposure meter, close the gap, log bar.
// A Curator or Admin whose active role is that role gets Curator Home or Admin Home instead (T21; Pages
// table, Home row). The active role only picks the view: every account is a member (D18), so switching
// the view to Member in the nav shows Member Home.

export function HomeView() {
  const { me, checkFailed } = useAuth();
  if (me === undefined && !checkFailed) {
    return (
      <p className={styles.status} role="status">
        Loading…
      </p>
    );
  }
  // A failed session check keeps showing the public page: its data is public either way, and the nav
  // already says the session could not be checked.
  if (me) {
    const role = me.user.activeRole;
    if (role === "curator" && me.user.roles.includes("curator")) return <CuratorHome />;
    if (role === "admin" && me.user.roles.includes("admin")) return <AdminHome me={me} />;
    if (me.user.roles.includes("member")) return <MemberHome />;
  }
  return <PublicHome signedIn={!!me} />;
}

// ---- anonymous Home ------------------------------------------------------------------------------

function PublicHome({ signedIn }: { signedIn: boolean }) {
  const [feed, retry] = useLoad(getPublicHome);
  return (
    <div className={styles.home} data-testid="public-home">
      <p className="lede">
        A weekly nutrient-and-sensitivity coach. Calorie trackers stop at calories; healthEat tells
        you when your week is running low on a nutrient and tracks how often you eat the ingredients
        your body reacts to.
      </p>
      <p className={styles.cta}>
        {signedIn ? null : (
          <>
            <Link href="/register" className="button-link">
              Create an account
            </Link>{" "}
            <Link href="/login">Sign in</Link> to start logging, or{" "}
          </>
        )}
        <Link href="/search">search foods</Link> in USDA FoodData Central.
      </p>

      <section aria-labelledby="feed-heading" data-testid="public-feed">
        <h2 id="feed-heading">This week on healthEat</h2>
        {feed.kind === "loading" ? (
          <p className={styles.status} role="status">
            Loading this week’s activity…
          </p>
        ) : feed.kind === "error" ? (
          <LoadError failure={feed.failure} retry={retry} testId="feed-error" />
        ) : (
          <PublicFeed data={feed.data} />
        )}
      </section>

      <section aria-labelledby="example-heading" data-testid="example-week">
        <h2 id="example-heading">
          Example week <span className={styles.badge}>sample data</span>
        </h2>
        <p className={styles.sub}>
          What a member’s 7-day bands look like. These numbers are made up, not anyone’s log.
        </p>
        <NutrientBands {...EXAMPLE_WEEK} initialRows={EXAMPLE_WEEK.bands.length} />
      </section>
    </div>
  );
}

function PublicFeed({ data }: { data: PublicHomeResponse }) {
  return (
    <>
      <p className={styles.sub} data-testid="feed-week">
        {shortDate(data.week.from)} to {shortDate(data.week.to)}, counted across every member. No
        usernames next to foods or allergens.
      </p>
      <div className={styles.feedGrid}>
        <div data-testid="feed-foods">
          <h3>Most-logged foods</h3>
          {data.foods.length === 0 ? (
            <p className={styles.muted}>Nothing logged this week yet.</p>
          ) : (
            <ol className={styles.countList}>
              {data.foods.map((f) => (
                <li key={f.fdcId}>
                  <Link href={`/food/${f.fdcId}`}>{f.description ?? `Food ${f.fdcId}`}</Link>
                  <span className={styles.count}>
                    {f.count} log{f.count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div data-testid="feed-allergens">
          <h3>Most-detected allergens</h3>
          {data.allergens.length === 0 ? (
            <p className={styles.muted}>No allergens detected in this week’s logs.</p>
          ) : (
            <ol className={styles.countList}>
              {data.allergens.map((a) => (
                <li key={a.key}>
                  {a.displayName}
                  <span className={styles.count}>
                    in {a.count} log{a.count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div data-testid="feed-profiles">
          <h3>Newest public profiles</h3>
          {data.profiles.length === 0 ? (
            <p className={styles.muted}>No public profiles yet.</p>
          ) : (
            <ul className={styles.countList}>
              {data.profiles.map((p) => (
                <li key={p.username}>
                  <span className={styles.username}>{p.username}</span>
                  <span>
                    {p.badges.map((b) => (
                      <span key={b} className="role-badge">
                        {b === "curator" ? "Curator" : "Member"}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

// ---- Member Home ---------------------------------------------------------------------------------

function MemberHome() {
  const [summary, retry] = useLoad(getSummary, null, true);
  return (
    <div className={styles.home} data-testid="member-home">
      {summary.kind === "loading" ? (
        <p className={styles.status} role="status">
          Loading your week…
        </p>
      ) : summary.kind === "error" ? (
        <LoadError failure={summary.failure} retry={retry} testId="summary-error" />
      ) : (
        <MemberWeek data={summary.data} />
      )}
      <LogBar />
    </div>
  );
}

function MemberWeek({ data }: { data: SummaryResponse }) {
  return (
    <>
      {data.alerts.length > 0 ? (
        <div className={styles.alert} role="alert" data-testid="alert-strip">
          {data.alerts.map((a) => (
            <p key={`${a.key}-${a.fdcId}`}>
              <span aria-hidden="true">⚠ </span>
              {a.displayName} detected today in{" "}
              <Link href={`/food/${a.fdcId}`}>{a.description ?? `food ${a.fdcId}`}</Link>
              {a.matchKind === "description" ? " (food-category estimate)" : ""}. {a.displayName} is
              on your avoid list.
            </p>
          ))}
        </div>
      ) : null}

      <section aria-labelledby="calories-heading" data-testid="calorie-meter">
        <h2 id="calories-heading">Today’s calories</h2>
        {data.calorieMeter ? (
          <CalorieMeter meter={data.calorieMeter} />
        ) : (
          <p className={styles.muted} data-testid="calorie-incomplete">
            Add your sex, birth year, height and weight, or set your own calorie band, in your{" "}
            <Link href="/profile#body">profile</Link> to see today’s meter.
          </p>
        )}
      </section>

      <section aria-labelledby="bands-heading" data-testid="bands-section">
        <h2 id="bands-heading">Nutrient coverage, last 7 days</h2>
        <p className={styles.sub} data-testid="target-basis">
          {shortDate(data.days[0]!.date)} to {shortDate(data.weekEnding)}.{" "}
          {data.targetBasis === "personal" ? (
            "Targets for your sex and age band."
          ) : (
            <>
              Targets from an adult reference: add your sex and birth year in your{" "}
              <Link href="/profile#body">profile</Link> for your own.
            </>
          )}{" "}
          Read the row, not a single day.
        </p>
        <NutrientBands bands={data.bands} days={data.days} loggedDays={data.loggedDays} />
      </section>

      <section aria-labelledby="exposure-heading" data-testid="exposure">
        <h2 id="exposure-heading">Sensitivity exposure, last 7 days</h2>
        <Exposure rows={data.exposure} />
      </section>

      {data.loggedDays > 0 ? <CloseTheGap bands={data.bands} /> : null}
    </>
  );
}

const METER_WORDS: Record<Meter["status"], string> = {
  under: "under target",
  on: "on target",
  over: "over target",
};

function CalorieMeter({ meter }: { meter: Meter }) {
  // At least 1, so a 0 to 0 band the member set never divides by zero.
  const max = Math.max(meter.high * 1.25, meter.kcal * 1.05, 1);
  const pos = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
  const kcal = (v: number) => Math.round(v).toLocaleString("en-US");
  return (
    <>
      <p className={styles.sub}>
        A reminder, not a measurement. Target {kcal(meter.low)} to {kcal(meter.high)} kcal
        {meter.basis === "set" ? ", your own band" : ", estimated from your profile"}.
      </p>
      <div className={styles.meter} aria-hidden="true">
        <span
          className={styles.meterBand}
          style={{ left: pos(meter.low), width: `calc(${pos(meter.high)} - ${pos(meter.low)})` }}
        />
        <span className={styles.meterFill} style={{ width: pos(meter.kcal) }} />
      </div>
      <p data-testid="calorie-status" data-status={meter.status}>
        About <strong>{kcal(meter.kcal)} kcal</strong> so far today ·{" "}
        <strong>{METER_WORDS[meter.status]}</strong>
      </p>
    </>
  );
}

function Exposure({ rows }: { rows: SummaryResponse["exposure"] }) {
  if (rows.length === 0) {
    return (
      <p className={styles.muted} data-testid="exposure-empty">
        You are not tracking any sensitivities yet.{" "}
        <Link href="/profile#allergens">Choose what to avoid or track</Link>.
      </p>
    );
  }
  return (
    <>
      <p className={styles.sub}>
        How many logged entries this week contained each ingredient. A pattern aid, not a measured
        dose and not medical advice.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Sensitivity</th>
            <th scope="col" className={styles.num}>
              Hits
            </th>
            <th scope="col">Against your threshold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-testid="exposure-row" data-over={r.overThreshold}>
              <th scope="row">
                {r.displayName}
                {r.estimate ? <span className={styles.badge}>food-category estimate</span> : null}
              </th>
              <td className={styles.num}>{r.hits}</td>
              <td>
                {r.weeklyThreshold === null ? (
                  <span className={styles.muted}>no threshold set</span>
                ) : r.overThreshold ? (
                  <strong>above ({r.weeklyThreshold} a week)</strong>
                ) : (
                  `within (${r.weeklyThreshold} a week)`
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function CloseTheGap({ bands }: { bands: readonly NutrientBand[] }) {
  const low = bands
    .filter((b) => b.status === "low" && nutrientIdFor(b.key) !== undefined)
    .sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0));
  const [picked, setPicked] = useState<string | null>(null);
  const band = low.find((b) => b.key === picked) ?? low[0];

  return (
    <section aria-labelledby="gap-heading" data-testid="close-the-gap">
      {band ? (
        <>
          <h2 id="gap-heading">
            Close the gap: {band.name} ({Math.round((band.coverage ?? 0) * 100)}%)
          </h2>
          {low.length > 1 ? (
            <div className={styles.choices} role="group" aria-label="Low nutrients">
              {low.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  aria-pressed={b.key === band.key}
                  onClick={() => setPicked(b.key)}
                >
                  {b.name}
                </button>
              ))}
            </div>
          ) : null}
          <GapFoods key={band.key} nutrientId={nutrientIdFor(band.key)!} />
        </>
      ) : (
        <>
          <h2 id="gap-heading">Close the gap</h2>
          <p className={styles.muted} data-testid="gap-none">
            No nutrient is low this week.
          </p>
        </>
      )}
    </section>
  );
}

function GapFoods({ nutrientId }: { nutrientId: number }) {
  const [gap, retry] = useLoad<GapFoodsResponse>(
    (signal) => getGapFoods(nutrientId, signal),
    nutrientId,
  );
  if (gap.kind === "loading") {
    return (
      <p className={styles.status} role="status">
        Finding foods…
      </p>
    );
  }
  if (gap.kind === "error")
    return <LoadError failure={gap.failure} retry={retry} testId="gap-error" />;
  const { nutrient, foods } = gap.data;
  return (
    <>
      <p className={styles.sub}>
        Foods with the most {nutrient.name} per calorie, leaving out any with an allergen you avoid.
      </p>
      {foods.length === 0 ? (
        <p className={styles.muted}>No suggestions for this nutrient right now.</p>
      ) : (
        <ul className={styles.countList} data-testid="gap-foods">
          {foods.map((f) => (
            <li key={f.fdcId}>
              <Link href={`/food/${f.fdcId}`}>{f.description}</Link>
              <span className={styles.count}>
                {formatAmount(f.portionGrams)} g · {formatAmount(f.amountPerPortion)}{" "}
                {nutrient.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.sub}>Open a food to see its details and add it to today’s log.</p>
    </>
  );
}

function LogBar() {
  const router = useRouter();
  const [q, setQ] = useState("");
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = q.trim();
    router.push(text ? searchHref({ q: text, page: 1 }) : "/search");
  }
  return (
    <form className={styles.logBar} role="search" onSubmit={onSubmit} data-testid="log-bar">
      <label htmlFor="log-bar-q" className={styles.srOnly}>
        Find a food to log
      </label>
      <input
        id="log-bar-q"
        type="search"
        placeholder="Log a meal: search a food"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        maxLength={200}
      />
      <button type="submit">Search</button>
      <Link href="/log?photo=1" data-testid="log-bar-photo">
        Log by photo
      </Link>
      <Link href="/log">Today’s log</Link>
    </form>
  );
}
