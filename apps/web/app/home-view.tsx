"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import { APP_NAME } from "@healtheat/shared";
import type {
  CalorieMeter as Meter,
  GapFoodsResponse,
  NutrientBand,
  PublicHomeResponse,
  SummaryResponse,
} from "@healtheat/shared";
import { NutrientBands } from "../components/NutrientBand";
import { useAuth } from "./auth-context";
import {
  formatDay,
  getGapFoods,
  getPublicHome,
  getSummary,
  nutrientIdFor,
  shortDate,
} from "./lib/home";
import { EXAMPLE_WEEK } from "./lib/example-week";
import { formatAmount } from "./lib/nutrients";
import { AdminHome } from "./admin-home";
import { CuratorHome } from "./curator-home";
import { LoadError, useLoad } from "./use-load";
import styles from "./home.module.css";

// Home (T30; design doc, Pages table and the Home wireframe), laid out as the v2 UI design's "Home,
// visitor" and "Member Home" artboards (T32). Anonymous visitors get a pitch, one labelled example
// week, the live public feed and a way in; a signed-in account gets Member Home in the wireframe's
// order: alert strip, today's calorie meter, the 7-day bands, exposure meter, close the gap, log bar.
// A Curator or Admin whose active role is that role gets Curator Home or Admin Home instead (T21; Pages
// table, Home row). The active role only picks the view: every account is a member (D18), so switching
// the view to Member in the nav shows Member Home.

export function HomeView({ children }: { children?: ReactNode }) {
  const { me, checkFailed } = useAuth();
  let view: ReactNode;
  let wide = false;
  if (me === undefined && !checkFailed) {
    view = (
      <>
        <h1>{APP_NAME}</h1>
        <p className={styles.status} role="status">
          Loading…
        </p>
      </>
    );
  } else {
    // A failed session check keeps showing the public page: its data is public either way, and the
    // nav already says the session could not be checked.
    const role = me?.user.activeRole;
    if (me && role === "curator" && me.user.roles.includes("curator")) {
      wide = true;
      view = (
        <>
          <h1>{APP_NAME}</h1>
          <CuratorHome />
        </>
      );
    } else if (me && role === "admin" && me.user.roles.includes("admin")) {
      wide = true;
      view = (
        <>
          <h1>{APP_NAME}</h1>
          <AdminHome me={me} />
        </>
      );
    } else if (me?.user.roles.includes("member")) {
      view = <MemberHome />;
    } else {
      view = <PublicHome signedIn={!!me} />;
    }
  }
  return (
    <main className={wide ? `${styles.main} ${styles.wide}` : styles.main}>
      {view}
      {children}
    </main>
  );
}

// ---- anonymous Home ------------------------------------------------------------------------------

function WayIn() {
  return (
    <div className={styles.actions}>
      <Link href="/register" className="button-link primary">
        Register
      </Link>
      <Link href="/login">Log in</Link>
    </div>
  );
}

function PublicHome({ signedIn }: { signedIn: boolean }) {
  const [feed, retry] = useLoad(getPublicHome);
  return (
    <div className={styles.home} data-testid="public-home">
      <h1>Eat well across the week</h1>
      <p className="lede">
        healthEat coaches your week of eating. Log meals by searching USDA foods or with a photo,
        then see which nutrients ran low or high over 7 days, and which foods would close the gap.
      </p>
      {signedIn ? (
        <div className={styles.actions}>
          <Link href="/search" className="button-link">
            Search foods
          </Link>
        </div>
      ) : (
        <WayIn />
      )}

      <section aria-labelledby="example-heading" data-testid="example-week">
        <div className={styles.sectionHead}>
          <h2 id="example-heading">Example week</h2>
          <span className="hint">Sample data, not a real member</span>
        </div>
        <NutrientBands {...EXAMPLE_WEEK} initialRows={EXAMPLE_WEEK.bands.length} />
      </section>

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

      {signedIn ? null : (
        <section aria-labelledby="start-heading" data-testid="start-week">
          <h2 id="start-heading">Start your own week</h2>
          <p>Register to log meals and see your own bands. Logging takes a search or a photo.</p>
          <WayIn />
        </section>
      )}
    </div>
  );
}

function PublicFeed({ data }: { data: PublicHomeResponse }) {
  const week = (
    <p className="hint" data-testid="feed-week">
      Counts are logs from {shortDate(data.week.from)} to {shortDate(data.week.to)} across all
      members. No usernames are shown with foods or allergens.
    </p>
  );
  if (data.foods.length === 0 && data.allergens.length === 0 && data.profiles.length === 0) {
    return (
      <>
        <p data-testid="feed-empty">Nothing has been logged on healthEat this week yet.</p>
        {week}
      </>
    );
  }
  return (
    <>
      <div className={styles.feedGrid}>
        <div data-testid="feed-foods">
          <h3>Foods logged most</h3>
          {data.foods.length === 0 ? (
            <p className="hint">Nothing logged this week yet.</p>
          ) : (
            <ol className={styles.rows}>
              {data.foods.map((f) => (
                <li key={f.fdcId}>
                  <Link href={`/food/${f.fdcId}`}>{f.description ?? `Food ${f.fdcId}`}</Link>
                  <span className={styles.num}>
                    {f.count}
                    <span className="sr-only"> log{f.count === 1 ? "" : "s"}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div data-testid="feed-allergens">
          <h3>Allergens detected most</h3>
          {data.allergens.length === 0 ? (
            <p className="hint">No allergens detected in this week’s logs.</p>
          ) : (
            <ol className={styles.rows}>
              {data.allergens.map((a) => (
                <li key={a.key}>
                  <span>{a.displayName}</span>
                  <span className={styles.num}>
                    {a.count}
                    <span className="sr-only"> log{a.count === 1 ? "" : "s"}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div data-testid="feed-profiles">
          <h3>Newest public profiles</h3>
          {data.profiles.length === 0 ? (
            <p className="hint">No public profiles yet.</p>
          ) : (
            <ul className={styles.rows}>
              {data.profiles.map((p) => (
                <li key={p.username}>
                  <span>
                    {p.username}
                    {p.badges.includes("curator") ? (
                      <span className={`role-badge ${styles.badge}`}>Curator</span>
                    ) : null}
                  </span>
                  <span className="hint">joined {formatDay(p.memberSince)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {week}
    </>
  );
}

// ---- Member Home ---------------------------------------------------------------------------------

function MemberHome() {
  const [summary, retry] = useLoad(getSummary, null, true);
  return (
    <div className={styles.home} data-testid="member-home">
      {summary.kind === "done" ? <AlertStrip alerts={summary.data.alerts} /> : null}
      <h1>Your week</h1>
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

function AlertStrip({ alerts }: { alerts: SummaryResponse["alerts"] }) {
  if (alerts.length === 0) return null;
  return (
    <div className={styles.alert} role="alert" data-testid="alert-strip">
      <p className={styles.alertTitle}>Allergy alert</p>
      {alerts.map((a) => (
        <p key={`${a.key}-${a.fdcId}`}>
          {a.displayName} detected today in{" "}
          <Link href={`/food/${a.fdcId}`}>{a.description ?? `food ${a.fdcId}`}</Link>
          {a.matchKind === "description" ? " (food-category estimate)" : ""}. {a.displayName} is on
          your avoid list.
        </p>
      ))}
      <p>
        <Link href="/log">Open today’s log</Link>
      </p>
    </div>
  );
}

function MemberWeek({ data }: { data: SummaryResponse }) {
  return (
    <>
      <section aria-labelledby="calories-heading" data-testid="calorie-meter">
        <h2 id="calories-heading">Today’s calories</h2>
        {data.calorieMeter ? (
          <CalorieMeter
            meter={data.calorieMeter}
            loggedToday={data.days.some((d) => d.date === data.today && d.logged)}
          />
        ) : (
          <p data-testid="calorie-incomplete">
            Add your sex, birth year, height and weight, or set your own calorie band, in your{" "}
            <Link href="/profile#body">profile</Link> to see today’s meter.
          </p>
        )}
      </section>

      <section aria-labelledby="bands-heading" data-testid="bands-section">
        <div className={styles.sectionHead}>
          <h2 id="bands-heading">Nutrient coverage, last 7 days</h2>
          <span className="hint">
            {shortDate(data.days[0]!.date)} to {shortDate(data.weekEnding)}
          </span>
        </div>
        <p className="hint" data-testid="target-basis">
          Each bar is the week’s average against your daily target; the dots show the days you
          logged.{" "}
          {data.targetBasis === "personal" ? (
            "Targets for your sex and age band."
          ) : (
            <>
              Targets from an adult reference: add your sex and birth year in your{" "}
              <Link href="/profile#body">profile</Link> for your own.
            </>
          )}
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
  under: "under",
  on: "within",
  over: "over",
};

function CalorieMeter({ meter, loggedToday }: { meter: Meter; loggedToday: boolean }) {
  // At least 1, so a 0 to 0 band the member set never divides by zero.
  const max = Math.max(meter.high * 1.3, meter.kcal * 1.05, 1);
  const pos = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
  const kcal = (v: number) => Math.round(v).toLocaleString("en-US");
  const band = `${kcal(meter.low)} to ${kcal(meter.high)} kcal`;
  const basis = meter.basis === "set" ? "set by you" : "estimated from your profile";
  return (
    <>
      <p className="hint">A rough reminder, not a measurement.</p>
      <div
        className={styles.meter}
        role="img"
        aria-label={`About ${kcal(meter.kcal)} kcal so far, ${METER_WORDS[meter.status]} your band of ${band}`}
      >
        <span
          className={styles.meterBand}
          style={{ left: pos(meter.low), width: `calc(${pos(meter.high)} - ${pos(meter.low)})` }}
        >
          <span>your band</span>
        </span>
        {meter.kcal > 0 ? (
          <span className={styles.meterFill} style={{ width: pos(meter.kcal) }} />
        ) : null}
      </div>
      {/* Whether anything was logged comes from the day, not the total: water or black coffee
          logs 0 kcal. */}
      <p data-testid="calorie-status" data-status={meter.status}>
        {loggedToday ? (
          <>
            <strong>About {kcal(meter.kcal)} kcal so far:</strong> {METER_WORDS[meter.status]} your
            band of {band}, {basis}.
          </>
        ) : (
          <>
            <strong>Nothing logged today yet.</strong> Your band is {band}, {basis}.
          </>
        )}
      </p>
    </>
  );
}

// The exposure meter's three zones, against the member's weekly threshold: Light up to half of it,
// Moderate up to it, Heavy past it (the API's overThreshold). The bar spans 0 to 1.5x the threshold,
// so the zone edges sit at its thirds.
const ZONES = ["Light", "Moderate", "Heavy"] as const;

function zoneOf(row: SummaryResponse["exposure"][number], threshold: number): 0 | 1 | 2 {
  if (row.overThreshold) return 2;
  return row.hits * 2 <= threshold ? 0 : 1;
}

function Exposure({ rows }: { rows: SummaryResponse["exposure"] }) {
  if (rows.length === 0) {
    return (
      <p data-testid="exposure-empty">
        You are not tracking any sensitivities.{" "}
        <Link href="/profile#allergens">Choose them on your profile.</Link>
      </p>
    );
  }
  return (
    <>
      <p className="hint">
        Logged entries this week that contained each ingredient you track. A pattern aid, not a
        measured dose and not medical advice.
      </p>
      {rows.map((r) => {
        const entries = `${r.hits} logged ${r.hits === 1 ? "entry" : "entries"} this week`;
        const t = r.weeklyThreshold;
        const zone = t === null ? null : zoneOf(r, t);
        return (
          <div
            key={r.key}
            className={styles.exposureRow}
            data-testid="exposure-row"
            data-over={r.overThreshold}
            data-zone={zone === null ? undefined : ZONES[zone].toLowerCase()}
          >
            <h3>
              {r.displayName}
              {r.estimate ? (
                <span className={`role-badge ${styles.badge}`}>food-category estimate</span>
              ) : null}
            </h3>
            {t === null || zone === null ? (
              <p>
                {entries}. No threshold set:{" "}
                <Link href="/profile#allergens">add one on your profile</Link> to see it on a meter.
              </p>
            ) : (
              <>
                <div
                  className={`${styles.meter} ${styles.plain}`}
                  role="img"
                  aria-label={`${r.displayName} this week: ${ZONES[zone].toLowerCase()}`}
                >
                  {r.hits > 0 ? (
                    <span
                      className={styles.meterFill}
                      style={{ width: `${Math.min(r.hits / (t * 1.5), 1) * 100}%` }}
                    />
                  ) : null}
                  <span className={styles.meterDiv} style={{ left: "33.333%" }} />
                  <span className={styles.meterDiv} style={{ left: "66.667%" }} />
                </div>
                <div className={styles.meterLabels} aria-hidden="true">
                  {ZONES.map((z, i) =>
                    i === zone ? <strong key={z}>{z}</strong> : <span key={z}>{z}</span>,
                  )}
                </div>
                <p>
                  {entries}; your threshold is {t} a week
                  {r.overThreshold ? ", and this week is above it" : ""}.
                </p>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** "Vitamin E" -> "vitamin E", "Fiber" -> "fiber": a nutrient's name inside a sentence. */
function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function CloseTheGap({ bands }: { bands: readonly NutrientBand[] }) {
  const low = bands
    .filter((b) => b.status === "low" && nutrientIdFor(b.key) !== undefined)
    .sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0));
  const [picked, setPicked] = useState<string | null>(null);
  const band = low.find((b) => b.key === picked) ?? low[0];

  return (
    <section aria-labelledby="gap-heading" data-testid="close-the-gap">
      <h2 id="gap-heading">Close the gap</h2>
      {band ? (
        <>
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
          <p data-testid="gap-lead">
            {band.name} was low this week, at {Math.round((band.coverage ?? 0) * 100)}% of your
            target. These foods add the most {lowerFirst(band.name)} per calorie and contain nothing
            you avoid.
          </p>
          <GapFoods key={band.key} nutrientId={nutrientIdFor(band.key)!} />
        </>
      ) : (
        <p data-testid="gap-none">No nutrient is low this week.</p>
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
  if (foods.length === 0)
    return <p className="hint">No suggestions for this nutrient right now.</p>;
  return (
    <ul className={styles.rows} data-testid="gap-foods">
      {foods.map((f) => (
        <li key={f.fdcId}>
          <Link href={`/food/${f.fdcId}`}>{f.description}</Link>
          <span className="hint">
            {formatAmount(f.portionGrams)} g, about {formatAmount(f.amountPerPortion)}{" "}
            {nutrient.unit} {lowerFirst(nutrient.name)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The log bar: two ways to log, at the end of Member Home on desktop and pinned to the bottom of the
// screen on phones (wireframe decision 1; design change list, "Persistent log bar, phone").
function LogBar() {
  return (
    <section className={styles.logBar} aria-label="Log a meal" data-testid="log-bar">
      <Link href="/search" className="button-link">
        Search food
      </Link>
      <Link href="/log?photo=1" className="button-link" data-testid="log-bar-photo">
        Log by photo
      </Link>
    </section>
  );
}
