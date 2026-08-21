import { createClient } from "@supabase/supabase-js";

/** Anon/publishable key only — this ships to the browser. RLS governs every
 *  read; the service-role key never appears here or anywhere in apps/web. */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy apps/web/.env.example to .env.local and fill them in.",
  );
}

/**
 * Auth-only client for the legacy Supabase login fallback.
 *
 * supabase-js intentionally disables its auth namespace when an external
 * accessToken callback is configured. Keeping this client separate lets the
 * data client above forward Clerk tokens to PostgREST/Realtime without
 * changing the existing Supabase OAuth/session lifecycle.
 */
export const supabaseAuth = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export const supabase = createClient(url, anonKey, {
  accessToken: async () => {
    if (typeof window === "undefined") return null;

    const clerk = (
      window as unknown as {
        Clerk?: {
          session?: { getToken: () => Promise<string | null> };
        };
      }
    ).Clerk;

    if (clerk?.session) {
      try {
        const token = await clerk.session.getToken();
        if (token) return token;
      } catch {
        // A transient Clerk refresh failure can still fall back to a valid
        // Supabase session for installations that keep the legacy login path.
      }
    }

    const { data } = await supabaseAuth.auth.getSession();
    return data.session?.access_token ?? null;
  },
});
