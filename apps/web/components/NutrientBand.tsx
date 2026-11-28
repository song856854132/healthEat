"use client";

import { useId, useState } from "react";
import { BAND_HIGH, BAND_LOW } from "@healtheat/shared";
import type { NutrientBand as Band, SummaryResponse } from "@healtheat/shared";
import { formatAmount } from "../app/lib/nutrients";
import styles from "./NutrientBand.module.css";

// The 7-day nutrient bands (T19; design doc, Working plan amendments C5, R3-12 and R3-13): one row per
// tracked nutrient, its fill encoding the band class (v2 UI design, T32: sparse hatch with a dashed
// outline = low, plain with a solid outline = ok, dense cross-hatch with a 2px outline = high), seven
// per-day dots under the "N of 7 days logged" header (filled = mostly searched, hollow = mostly
// photo-estimated, absent = unlogged). The classes come from the API (`status`); this only draws them.

type Day = SummaryResponse["days"][number];

/** A logged day draws a filled dot when at least this share of its grams came from search. */
export const SEARCHED_SHARE = 0.5;

export type DayState = "searched" | "photo" | "unlogged";

export function dayState(day: Day): DayState {
  if (!day.logged) return "unlogged";
  return (day.confidence ?? 1) >= SEARCHED_SHARE ? "searched" : "photo";
}

/** The bar spans 0 to 150% of the daily target; anything above is drawn at the right edge. */
const SCALE = 1.5;
const at = (share: number) => `${(Math.min(share, SCALE) / SCALE) * 100}%`;

const DAY_WORDS: Record<DayState, string> = {
  searched: "logged, mostly by search",
  photo: "logged, mostly photo-estimated",
  unlogged: "not logged",
};

// Most urgent first: low (lowest coverage first), then high, then ok, then rows without a figure.
const RANK: Record<Band["status"], number> = { low: 0, high: 1, ok: 2, insufficient: 3, empty: 4 };

export function sortBands(bands: readonly Band[]): Band[] {
  return [...bands].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      (a.status === "high" ? -1 : 1) * ((a.coverage ?? 0) - (b.coverage ?? 0)),
  );
}

// The band edges come from the shared thresholds the API classifies with, so ticks, legend and
// `status` cannot disagree.
const LOW_PCT = Math.round(BAND_LOW * 100);
const HIGH_PCT = Math.round(BAND_HIGH * 100);

const percent = (share: number) => `${Math.round(share * 100)}%`;

const amount = (value: number, unit: string) => `${formatAmount(value)} ${unit}`;

/** The words under a measured nutrient's name (v2 UI design, Member Home). */
const BAND_WORDS: Partial<Record<Band["status"], string>> = {
  low: "Low this week",
  ok: "OK this week",
  high: "High this week",
};

function DayDots({ days }: { days: readonly Day[] }) {
  return (
    <span className={styles.dots} aria-hidden="true">
      {days.map((d) => {
        const state = dayState(d);
        return (
          <span
            key={d.date}
            className={`${styles.dot} ${styles[state]}`}
            data-testid="day-dot"
            data-state={state}
            title={`${d.date}: ${DAY_WORDS[state]}`}
          />
        );
      })}
    </span>
  );
}

function BandRow({ band, days }: { band: Band; days: readonly Day[] }) {
  const measured = band.status === "low" || band.status === "ok" || band.status === "high";
  const coverage = band.coverage ?? 0;
  return (
    <li className={styles.row} data-testid="band-row" data-key={band.key} data-status={band.status}>
      <span className={styles.name}>
        <span className={styles.bandName}>{band.name}</span>
        {BAND_WORDS[band.status] ? (
          <span className={styles.bandWord} data-testid="band-word">
            {BAND_WORDS[band.status]}
          </span>
        ) : null}
      </span>
      <DayDots days={days} />
      {measured ? (
        <>
          <span
            className={styles.track}
            title={
              band.intakePerDay === null
                ? undefined
                : `About ${amount(band.intakePerDay, band.unit)} a day; target ${amount(band.target, band.unit)}${
                    band.upper === null ? "" : `, upper limit ${amount(band.upper, band.unit)}`
                  }`
            }
            aria-hidden="true"
          >
            <span
              className={`${styles.fill} ${styles[band.status]}`}
              style={{ width: at(coverage) }}
            />
            <span className={styles.tick} style={{ left: at(BAND_LOW) }} />
            <span className={`${styles.tick} ${styles.target}`} style={{ left: at(1) }} />
            <span className={styles.tick} style={{ left: at(BAND_HIGH) }} />
          </span>
          <span className={styles.value} data-testid="band-value">
            {percent(coverage)}
          </span>
        </>
      ) : (
        <span className={styles.note}>
          {band.status === "insufficient"
            ? `Not enough data: ${percent(band.dataCoverage)} of logged grams report it`
            : "No logs yet"}
        </span>
      )}
    </li>
  );
}

export function NutrientBands({
  bands,
  days,
  loggedDays,
  initialRows = 6,
}: {
  bands: readonly Band[];
  days: readonly Day[];
  loggedDays: number;
  /** Rows shown before "Show all"; the rest stay behind the toggle. */
  initialRows?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const sorted = sortBands(bands);
  const shown = expanded ? sorted : sorted.slice(0, initialRows);
  const states = days.map(dayState);
  const photoDays = states.filter((s) => s === "photo").length;

  return (
    <div className={styles.bands} data-testid="nutrient-bands">
      <p className={styles.header} data-testid="band-header">
        <strong>
          {loggedDays} of {days.length} days logged
        </strong>
        {photoDays > 0 ? ` · ${photoDays} mostly photo-estimated` : null}
        <span className={styles.srOnly}>
          {" "}
          ({days.map((d, i) => `${d.date}: ${DAY_WORDS[states[i]!]}`).join("; ")})
        </span>
      </p>
      {loggedDays === 0 ? (
        <p className={styles.empty} data-testid="bands-empty">
          Nothing logged in the last 7 days. Each day you log fills in a column here.
        </p>
      ) : (
        <>
          <div className={styles.columns} aria-hidden="true">
            <span />
            <span className={styles.dots}>
              {days.map((d) => (
                <span key={d.date} className={styles.dayLetter} title={d.date}>
                  {new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", {
                    weekday: "narrow",
                    timeZone: "UTC",
                  })}
                </span>
              ))}
            </span>
            <span className={styles.scale}>share of daily target, average of logged days</span>
            <span />
          </div>
          <ul className={styles.list} id={listId}>
            {shown.map((band) => (
              <BandRow key={band.key} band={band} days={days} />
            ))}
          </ul>
          {sorted.length > initialRows ? (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Show fewer" : `Show all ${sorted.length} nutrients`}
            </button>
          ) : null}
          <ul className={styles.legend} data-testid="band-legend">
            <li>
              <span className={`${styles.swatch} ${styles.low}`} aria-hidden="true" />
              Low: under {LOW_PCT}% of target
            </li>
            <li>
              <span className={`${styles.swatch} ${styles.ok}`} aria-hidden="true" />
              OK: in range
            </li>
            <li>
              <span className={`${styles.swatch} ${styles.high}`} aria-hidden="true" />
              High: over {HIGH_PCT}% or the upper limit
            </li>
            <li>
              <span className={`${styles.dot} ${styles.searched}`} aria-hidden="true" />
              Logged by search
            </li>
            <li>
              <span className={`${styles.dot} ${styles.photo}`} aria-hidden="true" />
              Mostly a photo estimate
            </li>
            <li>No dot: not logged</li>
          </ul>
        </>
      )}
    </div>
  );
}
