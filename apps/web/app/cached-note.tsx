import styles from "./foods.module.css";

/**
 * The "cached" label (design doc D5, failure table): USDA failed, so the API served its stored copy.
 * The date is shown in UTC so server and browser render the same text.
 */
export function CachedNote({ fetchedAt }: { fetchedAt: string }) {
  const when = new Date(fetchedAt);
  const label = Number.isNaN(when.getTime())
    ? "an earlier date"
    : when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) +
      " UTC";
  return (
    <p className={styles.cached} data-testid="cached-note">
      <strong>Cached</strong> USDA is not answering right now, so this is the copy saved on {label}.
    </p>
  );
}
