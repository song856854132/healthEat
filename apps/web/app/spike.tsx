"use client";

import { useEffect, useState } from "react";
import type { HealthResponse, WhoAmI } from "@healtheat/shared";

// Proxy spike UI (plan task T1). Everything here calls /api/* on this origin; the Next.js
// rewrite forwards to the Express service. If the cookie survives, "whoami" shows a name.
export function Spike() {
  const [health, setHealth] = useState<HealthResponse | { error: string } | null>(null);
  const [who, setWho] = useState<WhoAmI | null>(null);

  async function refreshWho() {
    const r = await fetch("/api/spike/whoami", { cache: "no-store" });
    setWho((await r.json()) as WhoAmI);
  }

  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then(async (r) =>
        setHealth(r.ok ? ((await r.json()) as HealthResponse) : { error: `HTTP ${r.status}` }),
      )
      .catch((e: unknown) => setHealth({ error: e instanceof Error ? e.message : "fetch failed" }));
    void refreshWho();
  }, []);

  async function login() {
    await fetch("/api/spike/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "spike-user" }),
    });
    await refreshWho();
  }
  async function logout() {
    await fetch("/api/spike/logout", { method: "POST" });
    await refreshWho();
  }

  return (
    <section aria-label="proxy spike">
      <h2>API through the same-origin proxy</h2>
      <p>
        Rewrite target at build time: <code>{process.env.NEXT_PUBLIC_API_ORIGIN_LABEL}</code>
      </p>
      <pre data-testid="health">{health ? JSON.stringify(health, null, 2) : "loading…"}</pre>
      <p>
        Cookie identity:{" "}
        <strong data-testid="whoami">{who ? (who.name ?? "anonymous") : "…"}</strong>
      </p>
      <button type="button" onClick={login} data-testid="login">
        Set cookie
      </button>
      <button type="button" onClick={logout} data-testid="logout">
        Clear cookie
      </button>
    </section>
  );
}
