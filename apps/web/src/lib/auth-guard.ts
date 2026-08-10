/**
 * Route-level auth guard for TanStack Router.
 *
 * Reads the Supabase session + JWT app_role claim and enforces the role
 * mapping at the router `beforeLoad` level — the page never renders if
 * the user isn't authorised.
 *
 * States handled:
 *  - No session → redirect to /login
 *  - Session but no app_role claim → redirect to /no-role (clear message)
 *  - Wrong role → redirect to that role's home (no leaking page existence)
 */

import { redirect } from "@tanstack/react-router";
import { supabase } from "@/lib/supabase/client";

export type AppRole = "teacher" | "management" | "admin" | "student";

/** Where each role lands after login or when redirected from a forbidden page. */
export const ROLE_HOME: Record<AppRole, string> = {
  teacher: "/teacher",
  management: "/management",
  admin: "/admin",
  student: "/me",
};

/** Which roles may access each shell route. */
export const ROUTE_ROLES: Record<string, AppRole[]> = {
  "/capture": ["teacher", "admin"],
  "/teacher": ["teacher", "admin"],
  "/sessions": ["teacher", "admin"],
  "/proctor": ["teacher", "admin"],
  "/management": ["management", "admin"],
  "/trends": ["management", "admin"],
  "/admin": ["admin"],
  "/enrollment": ["admin"],
  "/me": ["teacher", "management", "admin", "student"], // any authenticated
};

interface AuthResult {
  role: AppRole | null;
  authenticated: boolean;
}

/** Resolve the current user's auth state from the Supabase session JWT or DB. */
async function resolveAuth(): Promise<AuthResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return { role: null, authenticated: false };

  // 1. Decode app_role from the signed JWT (injected by the Access Token Hook if enabled)
  let role: AppRole | null = null;
  const payload = session.access_token?.split(".")[1];
  if (payload) {
    try {
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
      const claims = JSON.parse(atob(padded));
      if (claims.app_role) role = claims.app_role as AppRole;
    } catch {
      /* ignore */
    }
  }

  // 2. If JWT claim not present (hook not enabled in Supabase dashboard), query user_roles table
  if (!role && session.user?.id) {
    try {
      const { data } = await supabase
        .from("user_roles")
        .select("app_role")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (data?.app_role) {
        role = data.app_role as AppRole;
      }
    } catch {
      /* ignore */
    }
  }

  // If neither source provided a role, return null — the guard will redirect
  // to /no-role with an explanatory message. Never silently default to any role.

  return { role, authenticated: true };
}

/**
 * TanStack Router `beforeLoad` guard factory.
 *
 * Usage in a route file:
 *   beforeLoad: guardRoute(["teacher", "admin"])
 *
 * Or for "any authenticated user":
 *   beforeLoad: guardRoute("authenticated")
 */
export function guardRoute(allowedRoles: AppRole[] | "authenticated") {
  return async () => {
    // SSR has no localStorage, so Supabase can't see the persisted session and
    // resolveAuth would report "not authenticated" — bouncing every refresh to
    // /login. Skip the guard on the server and let the client (which holds the
    // session) enforce it; client-side navigations still run the full check.
    if (typeof window === "undefined") return {};

    const { role, authenticated } = await resolveAuth();

    if (!authenticated) {
      throw redirect({ to: "/login" });
    }

    if (!role) {
      throw redirect({ to: "/no-role" });
    }

    if (allowedRoles !== "authenticated" && !allowedRoles.includes(role)) {
      // Signed in with wrong role → send to their own home
      throw redirect({ to: ROLE_HOME[role] });
    }

    return { role };
  };
}

/** Determine the home route for a given role (used after login). */
export function homeForRole(role: AppRole | null): string {
  if (!role) return "/no-role";
  return ROLE_HOME[role] ?? "/no-role";
}
