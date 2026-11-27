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
import { fetchMe, logout as apiLogout, onSignedOut } from "./lib/api";

// undefined = not known yet (still asking, or every answer so far was an error); null = signed out
// (the server said so); otherwise the account.
type Session = MeResponse | null | undefined;

type AuthState = {
  me: Session;
  /**
   * The last GET /api/auth/me failed (5xx, network error, unexpected body). `me` keeps what it was:
   * only the server saying "no session" signs the user out in the UI.
   */
  checkFailed: boolean;
  /**
   * Ask GET /api/auth/me again. Resolves to the answer it applied, or undefined when it failed or a
   * newer session change made it stale.
   */
  recheck: () => Promise<Session>;
  /** The account a login or register just returned; wins over any /me answer still in flight. */
  setMe: (me: MeResponse) => void;
  /** The server ended the session another way (the account was deleted): show signed out. */
  clear: () => void;
  /** Ends the server session; `me` is cleared only when the server confirms. */
  logout: () => Promise<{ ok: true } | { ok: false; message: string }>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Session>(undefined);
  const [checkFailed, setCheckFailed] = useState(false);
  // Bumped by every check and every explicit session change. A /me answer that started under an
  // older generation is stale (it may be a 401 from before the login set he_sid) and is dropped.
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const apply = useCallback((next: MeResponse | null) => {
    generation.current += 1;
    inFlight.current?.abort();
    setCheckFailed(false);
    setMeState(next);
  }, []);

  // The newest check, so one that a later check cut short can answer with that one's result.
  const latest = useRef<{ gen: number; check: Promise<Session> } | null>(null);

  const recheck = useCallback((): Promise<Session> => {
    const gen = ++generation.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const check: Promise<Session> = (async () => {
      try {
        const result = await fetchMe(controller.signal);
        if (gen === generation.current) {
          setCheckFailed(false);
          setMeState(result);
          return result;
        }
      } catch {
        if (gen === generation.current) {
          setCheckFailed(true);
          return undefined;
        }
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
      // A newer check replaced this one (the window took focus or the tab became visible): answer with its
      // result, so a caller that must know the session (confirmSession before a write) is not refused
      // for nothing. After an explicit session change there is no newer check: undefined, as before.
      const newer = latest.current;
      return newer && newer.gen !== gen ? newer.check : undefined;
    })();
    latest.current = { gen, check };
    return check;
  }, []);

  useEffect(() => {
    void recheck();
    // The server can end the session while this tab sits open (expiry, suspension, logout in another
    // tab): look again whenever the user comes back to the tab, and on any 401 from the API.
    const onVisible = () => {
      if (document.visibilityState === "visible") void recheck();
    };
    const onFocus = () => void recheck();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const unsubscribe = onSignedOut(() => apply(null));
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      unsubscribe();
      generation.current += 1;
      inFlight.current?.abort();
    };
  }, [recheck, apply]);

  const setMe = useCallback((next: MeResponse) => apply(next), [apply]);
  const clear = useCallback(() => apply(null), [apply]);

  const logout = useCallback(async () => {
    const result = await apiLogout();
    if (result.ok) apply(null);
    return result;
  }, [apply]);

  const value = useMemo(
    () => ({ me, checkFailed, recheck, setMe, clear, logout }),
    [me, checkFailed, recheck, setMe, clear, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
