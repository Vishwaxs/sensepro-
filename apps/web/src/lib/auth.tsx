/** Reactive "who is signed in" hook.
 *
 * Integrates Clerk authentication as the primary identity provider,
 * with Supabase session support as a fallback.
 */

import { useUser } from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { supabaseAuth } from "@/lib/supabase/client";
import type { AppRole } from "@/lib/auth-guard";

export interface AuthUser {
  id: string;
  email: string;
  role: AppRole | null;
  full_name: string;
}

export const ROLE_LABEL: Record<AppRole, string> = {
  teacher: "Teacher",
  management: "Management",
  admin: "Admin",
  student: "Student",
};

function extractSupabaseRole(session: { access_token?: string; user?: { user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> } } | null): AppRole | null {
  if (!session) return null;
  const payload = session.access_token?.split(".")[1];
  if (payload) {
    try {
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
      const claims = JSON.parse(atob(padded));
      if (claims.app_role && ["teacher", "management", "admin", "student"].includes(claims.app_role)) {
        return claims.app_role as AppRole;
      }
    } catch {
      /* ignore */
    }
  }
  const metaRole = (session.user?.user_metadata?.role ||
    session.user?.app_metadata?.role ||
    session.user?.app_metadata?.app_role) as AppRole | undefined;
  if (metaRole && ["teacher", "management", "admin", "student"].includes(metaRole)) {
    return metaRole;
  }
  return null;
}

export function useAuth() {
  const { user: clerkUser, isLoaded: clerkLoaded, isSignedIn: clerkSignedIn } = useUser();
  const [supabaseUser, setSupabaseUser] = useState<AuthUser | null>(null);
  const [supabaseLoading, setSupabaseLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabaseAuth.auth.getSession().then(({ data }) => {
      if (mounted) {
        if (data.session?.user) {
          const user = data.session.user;
          const full_name =
            (user.user_metadata?.full_name as string | undefined) ||
            user.email?.split("@")[0] ||
            "User";
          const role = extractSupabaseRole(data.session);
          setSupabaseUser({
            id: user.id,
            email: user.email ?? "",
            role,
            full_name,
          });
        } else {
          setSupabaseUser(null);
        }
        setSupabaseLoading(false);
      }
    });

    const { data: sub } = supabaseAuth.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        if (session?.user) {
          const user = session.user;
          const full_name =
            (user.user_metadata?.full_name as string | undefined) ||
            user.email?.split("@")[0] ||
            "User";
          const role = extractSupabaseRole(session);
          setSupabaseUser({
            id: user.id,
            email: user.email ?? "",
            role,
            full_name,
          });
        } else {
          setSupabaseUser(null);
        }
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // 1. If Clerk is loaded and user is signed in
  if (clerkLoaded && clerkSignedIn && clerkUser) {
    const candidate =
      (clerkUser.publicMetadata?.role as string | undefined) ||
      (clerkUser.unsafeMetadata?.role as string | undefined) ||
      (import.meta.env.DEV ? "teacher" : undefined);
    const role =
      candidate && ["teacher", "management", "admin", "student"].includes(candidate)
        ? (candidate as AppRole)
        : null;

    const email = clerkUser.primaryEmailAddress?.emailAddress ?? "";
    const full_name =
      clerkUser.fullName ||
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      email.split("@")[0] ||
      "User";

    return {
      user: {
        id: clerkUser.id,
        email,
        role,
        full_name,
      },
      loading: false,
    };
  }

  // 2. If Clerk is loaded and signed out, check Supabase
  if (clerkLoaded && !clerkSignedIn) {
    if (supabaseUser) {
      return { user: supabaseUser, loading: false };
    }
    return { user: null, loading: false };
  }

  // 3. Still loading
  return { user: null, loading: true };
}

interface ClerkSignOutWindow {
  Clerk?: {
    signOut: () => Promise<void>;
  };
}

export async function signOut(): Promise<void> {
  if (typeof window !== "undefined") {
    const clerk = (window as unknown as ClerkSignOutWindow).Clerk;
    if (clerk) {
      try {
        await clerk.signOut();
      } catch {
        /* ignore */
      }
    }
  }
  try {
    await supabaseAuth.auth.signOut();
  } catch {
    /* ignore */
  }
}
