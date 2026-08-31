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
 */
export const supabaseAuth = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export const supabase = createClient(url, anonKey, {
  accessToken: async () => {
    try {
      const { data } = await supabaseAuth.auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  },
});
