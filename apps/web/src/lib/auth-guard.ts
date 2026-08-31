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
import { supabaseAuth } from "@/lib/supabase/client";

export type AppRole = "teacher" | "management" | "admin" | "student";

/** sessionStorage key holding the post-sign-in destination across an OAuth
 *  round trip. The provider redirect leaves the app, so the ?redirect= search
 *  param that guardRoute attaches cannot survive it; /auth/callback reads this
 *  back. sessionStorage (not localStorage) so it dies with the tab and can
 *  never redirect a later, unrelated sign-in. */
export const POST_AUTH_REDIRECT_KEY = "sp:post-auth-redirect";

/** Where each role lands after login or when redirected from a forbidden page. */
export const ROLE_HOME: Record<AppRole, string> = {
  teacher: "/teacher",
  management: "/management",
  admin: "/admin",
  student: "/me",
};

/** Which roles may access each shell route. */
export const ROUTE_ROLES: Record<string, AppRole[]> = {
  "/start": ["teacher", "admin"],
  "/capture": ["teacher", "admin"],
  "/teacher": ["teacher", "admin"],
  "/sessions": ["teacher", "admin"],
  "/proctor": ["teacher", "admin"],
  "/management": ["management", "admin"],
  "/trends": ["management", "admin"],
  "/admin": ["admin"],
  "/enrollment": ["admin"],
  "/me": ["student", "admin"],
  "/claim": ["student", "admin"],
};

interface AuthResult {
  role: AppRole | null;
  authenticated: boolean;
}

interface ClerkUser {
  publicMetadata?: { role?: string };
  unsafeMetadata?: { role?: string };
}

interface ClerkInstance {
  loaded?: boolean;
  user?: ClerkUser;
}

interface ClerkGuardWindow {
  Clerk?: ClerkInstance;
}

async function waitForClerk(): Promise<ClerkInstance | null> {
  if (typeof window === "undefined") return null;

  // Poll for window.Clerk to be attached and initialized
  const maxWaitMs = 2500;
  const intervalMs = 30;
  let waited = 0;

  while (waited < maxWaitMs) {
    const clerk = (window as unknown as ClerkGuardWindow).Clerk;
    if (clerk && clerk.loaded) {
      return clerk;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    waited += intervalMs;
  }

  return (window as unknown as ClerkGuardWindow).Clerk ?? null;
}

/** Resolve the current user's auth state from Clerk or Supabase. */
async function resolveAuth(): Promise<AuthResult> {
  if (typeof window !== "undefined") {
    const clerk = await waitForClerk();
    if (clerk?.loaded && clerk.user) {
      let candidate =
        clerk.user.publicMetadata?.role ||
        clerk.user.unsafeMetadata?.role ||
        (import.meta.env.DEV ? "teacher" : undefined);

      if (!candidate) {
        try {
          const userEmail = (clerk.user as unknown as { primaryEmailAddress?: { emailAddress?: string }; emailAddresses?: Array<{ emailAddress?: string }> })?.primaryEmailAddress?.emailAddress ??
            (clerk.user as unknown as { emailAddresses?: Array<{ emailAddress?: string }> })?.emailAddresses?.[0]?.emailAddress;
          const uid = (clerk.user as unknown as { id?: string })?.id;
          const { fetchMyRoleRequestStatus } = await import("@/lib/data/role-requests");
          const req = await fetchMyRoleRequestStatus(userEmail, uid);
          if (req?.status === "approved" && (req.resolved_role || req.requested_role)) {
            candidate = req.resolved_role || req.requested_role;
            const clerkUserObj = clerk.user as unknown as { update?: (args: unknown) => Promise<unknown>; unsafeMetadata?: Record<string, unknown> };
            if (typeof clerkUserObj.update === "function") {
              void clerkUserObj.update({
                unsafeMetadata: {
                  ...clerkUserObj.unsafeMetadata,
                  role: candidate,
                },
              }).catch(() => {});
            }
          }
        } catch {
          /* ignore */
        }
      }

      const role =
        candidate && ["teacher", "management", "admin", "student"].includes(candidate)
          ? (candidate as AppRole)
          : null;
      return { role, authenticated: true };
    }
  }

  const {
    data: { session },
  } = await supabaseAuth.auth.getSession();

  if (!session) return { role: null, authenticated: false };

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

  if (!role) {
    const metaRole = (session.user?.user_metadata?.role ||
      session.user?.app_metadata?.role ||
      session.user?.app_metadata?.app_role) as AppRole | undefined;
    if (metaRole && ["teacher", "management", "admin", "student"].includes(metaRole)) {
      role = metaRole;
    }
  }

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
      // Carry the destination through the sign-in round trip. Without this the
      // QR flow breaks on the most common phone path: iOS Camera opens the link
      // in Safari and Android Lens in a Chrome Custom Tab, which are often NOT
      // where the student's session lives, so /claim?token=... bounces to
      // /login and the token is discarded. They then land on /me with no
      // explanation, and the token they spent the trip on is single-use and has
      // already rotated (AbsenteeQR mints a new one about every minute).
      throw redirect({
        to: "/login",
        search: { redirect: window.location.pathname + window.location.search },
      });
    }

    if (!role) {
      throw redirect({ to: "/no-role" });
    }

    if (allowedRoles !== "authenticated") {
      const isAllowed = role === "admin" || allowedRoles.includes(role);
      if (!isAllowed) {
        // Signed in with wrong role → send to their own home
        throw redirect({ to: ROLE_HOME[role] });
      }
    }

    return { role };
  };
}

/** Determine the home route for a given role (used after login). */
export function homeForRole(role: AppRole | null): string {
  if (!role) return "/no-role";
  return ROLE_HOME[role] ?? "/no-role";
}
