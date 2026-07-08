/** In-memory session context. Deliberately no localStorage/sessionStorage —
 *  real auth arrives with Supabase in Week 2; this only carries the chosen
 *  role through the SPA for role-aware navigation. */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Role } from "./types";

export interface AppUser {
  name: string;
  email: string;
  role: Role;
}

interface AuthContextValue {
  user: AppUser | null;
  signIn: (user: AppUser) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const signIn = useCallback((u: AppUser) => setUser(u), []);
  const signOut = useCallback(() => setUser(null), []);
  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export const ROLE_HOME: Record<Role, string> = {
  teacher: "/teacher",
  management: "/management",
  admin: "/admin",
  student: "/me",
};
