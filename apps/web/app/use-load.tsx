"use client";

import { useEffect, useState } from "react";
import { NETWORK } from "./lib/foods";
import type { Failure } from "./lib/foods";
import styles from "./home.module.css";

// Loading state shared by the Home views (T30) and the Curator and Admin pages (T21).

export type Load<T> =
  { kind: "loading" } | { kind: "error"; failure: Failure } | { kind: "done"; data: T };

/**
 * Runs `load` on mount and whenever `retry` is called; a newer run aborts the older one. With
 * `refreshOnReturn`, it also runs again, without going back to "Loading…", when the tab becomes
 * visible again, so a page left open does not keep showing yesterday's alerts or meter.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<{ ok: true; data: T } | { ok: false; failure: Failure }>,
  key: unknown = null,
  refreshOnReturn = false,
): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!refreshOnReturn) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshOnReturn]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (r) => {
        // A background refresh that fails keeps what is on screen rather than replacing it.
        if (r.ok) setState({ kind: "done", data: r.data });
        else
          setState((s) =>
            s.kind === "done" && refreshOnReturn ? s : { kind: "error", failure: r.failure },
          );
      },
      () => {
        // Aborted: a newer request replaced this one. Anything else must not spin forever.
        if (!controller.signal.aborted) setState({ kind: "error", failure: NETWORK });
      },
    );
    return () => controller.abort();
    // Not on `load`'s identity: callers pass a module-level function, or an inline one plus the `key`
    // it depends on, so an inline closure does not refetch on every render.
  }, [key, attempt]);
  return [
    state,
    () => {
      setState({ kind: "loading" });
      setAttempt((n) => n + 1);
    },
  ];
}

export function LoadError({
  failure,
  retry,
  testId,
}: {
  failure: Failure;
  retry: () => void;
  testId: string;
}) {
  return (
    <div className={styles.error} role="alert" data-testid={testId}>
      <p>{failure.message}</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
