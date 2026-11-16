"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { MeResponse } from "@healtheat/shared";
import { fetchMe, logout as apiLogout } from "./lib/api";

// undefined = still asking GET /api/auth/me; null = signed out (401); otherwise the account.
type Session = MeResponse | null | undefined;

type AuthState = {
  me: Session;
  /** The account a login or register just returned; wins over any /me answer still in flight. */
  setMe: (me: MeResponse) => void;
  /** Ends the server session; `me` is cleared only when the server confirms. */
  logout: () => Promise<{ ok: true } | { ok: false; message: string }>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Session>(undefined);
  // Bumped by every explicit session change. A /me answer that started under an older generation is
  // stale (it may be a 401 from before the login set he_sid) and is dropped instead of applied.
  const generation = useRef(0);

  useEffect(() => {
    const gen = generation.current;
    const controller = new AbortController();
    fetchMe(controller.signal)
      .catch(() => (controller.signal.aborted ? undefined : null)) // API down: show signed-out nav
      .then((result) => {
        if (result !== undefined && gen === generation.current) setMeState(result);
      });
    return () => controller.abort();
  }, []);

  const setMe = useCallback((next: MeResponse) => {
    generation.current += 1;
    setMeState(next);
  }, []);

  const logout = useCallback(async () => {
    const result = await apiLogout();
    if (result.ok) {
      generation.current += 1;
      setMeState(null);
    }
    return result;
  }, []);

  const value = useMemo(() => ({ me, setMe, logout }), [me, setMe, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
