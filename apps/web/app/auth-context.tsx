"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MeResponse } from "@healtheat/shared";
import { fetchMe, logout as apiLogout } from "./lib/api";

// undefined = still asking GET /api/auth/me; null = signed out (401); otherwise the account.
type Session = MeResponse | null | undefined;

type AuthState = {
  me: Session;
  setMe: (me: MeResponse | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Session>(undefined);

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe());
    } catch {
      // The API is down or misconfigured; show the signed-out nav rather than spinning forever.
      setMe(null);
    }
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ me, setMe, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
