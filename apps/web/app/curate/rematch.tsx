"use client";

import { useRef, useState } from "react";
import type { RematchProgress } from "@healtheat/shared";
import { continueRematch } from "../lib/curate";

/**
 * "Continue re-match" (design doc, Pages table: re-match status and "Continue re-match"). A dictionary
 * write re-matches cached foods for up to 60 seconds and answers 202 when foods are left; each press runs
 * POST /api/curate/allergens/:id/rematch for up to another 60 seconds, until it answers done.
 */
export function RematchControl({
  id,
  name,
  initial,
  onDone,
}: {
  id: string;
  /** The allergen's display name, so each button in a table has its own accessible name. */
  name: string;
  /** Progress a write just answered; without it the entry is only known to be unfinished. */
  initial?: RematchProgress;
  onDone?: () => void;
}) {
  const [progress, setProgress] = useState<RematchProgress | undefined>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function onContinue() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await continueRematch(id);
      if (result.ok) {
        setProgress(result.data);
        if (result.data.done) onDone?.();
      } else setError(result.failure.message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (progress?.done)
    return (
      <span role="status" data-testid="rematch-done">
        Re-match done
      </span>
    );
  return (
    <span data-testid="rematch-pending">
      <span>
        {pending
          ? "Re-matching cached foods…"
          : progress
            ? `${progress.remaining} food${progress.remaining === 1 ? "" : "s"} left to re-match`
            : "Re-match unfinished"}
      </span>{" "}
      <button
        type="button"
        onClick={() => void onContinue()}
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={`Continue re-match for ${name}`}
      >
        Continue re-match
      </button>
      {error ? (
        <span className="field-error" role="alert">
          {" "}
          {error}
        </span>
      ) : null}
    </span>
  );
}
