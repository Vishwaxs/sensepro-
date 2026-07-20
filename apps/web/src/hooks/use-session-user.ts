import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  roles: string[];
}

export function useSessionUser() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (!mounted) return;

        if (authUser) {
          setUser({
            id: authUser.id,
            email: authUser.email ?? "",
            full_name: authUser.user_metadata?.full_name ?? authUser.email?.split("@")[0] ?? "User",
            roles: (authUser.user_metadata?.roles as string[]) ?? ["teacher"],
          });
        } else {
          setUser(null);
        }
      } catch {
        // Supabase not configured — use stub user for demo
        if (mounted) {
          setUser({
            id: "demo-user",
            email: "demo@campus.edu",
            full_name: "Dr. R. Rao",
            roles: ["teacher", "admin", "management"],
          });
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email ?? "",
          full_name: session.user.user_metadata?.full_name ?? session.user.email?.split("@")[0] ?? "User",
          roles: (session.user.user_metadata?.roles as string[]) ?? ["teacher"],
        });
      } else {
        setUser(null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}
