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

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
