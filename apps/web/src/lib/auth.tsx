/** Real Supabase session, wrapped to the same shape the rest of the app
 *  already consumes (AppShell, RoleRedirect, SideNav all read `user.role`
 *  and call `signOut()` — unchanged by this file).
 *
 *  The app_role claim is injected into the JWT server-side by the Postgres
 *  Access Token Hook (supabase/migrations/0003_auth_role_hook.sql) — per
 *  Supabase's own docs, a custom-claims hook modifies the access TOKEN, not
 *  the auth response, so it must be read by decoding session.access_token,
 *  not from session.user.app_metadata:
 *  https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Role } from "./types";

export interface AppUser {
  name: string;
  email: string;
  role: Role;
}

interface AuthContextValue {
  user: AppUser | null;
  /** True until the initial session check resolves — route guards should
   *  wait on this rather than treating "no user yet" as "signed out". */
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Decode a JWT payload without a network call or extra dependency. Never
 *  verifies the signature — that's the server's job; the client only reads
 *  claims it already trusts because Supabase just handed it this token. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) return {};
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function toAppUser(session: Session | null): AppUser | null {
  if (!session) return null;
  const claims = decodeJwtPayload(session.access_token);
  const role = claims.app_role as Role | undefined;
  if (!role) return null; // hook not enabled yet, or role not linked — no access
  const name =
    (session.user.user_metadata?.full_name as string | undefined) ||
    session.user.email?.split("@")[0] ||
    "User";
  return { name, email: session.user.email ?? "", role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(toAppUser(data.session));
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(toAppUser(session));
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading]);
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
