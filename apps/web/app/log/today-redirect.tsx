"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { memberTimeZone, todayIn } from "../lib/logs";

/** Sends /log to /log/<today in the member's time zone>; signed-out visitors go to log in. */
export function TodayRedirect() {
  const { me } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me === null) {
      router.replace("/login");
      return;
    }
    if (!me) return;
    const controller = new AbortController();
    memberTimeZone(controller.signal).then(
      (r) => {
        if (r.ok) router.replace(`/log/${todayIn(r.data)}`);
        else setError(r.failure.message);
      },
      () => undefined, // aborted
    );
    return () => controller.abort();
  }, [me, router]);

  return (
    <main>
      <h1>Day log</h1>
      <p className={error ? "form-error" : "hint"}>{error ?? "Opening today’s log…"}</p>
    </main>
  );
}
