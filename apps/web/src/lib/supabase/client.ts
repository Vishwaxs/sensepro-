import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[SensePro+] Supabase env vars not set. Auth will run in stub mode. " +
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env to enable."
  );
}

export const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY || "placeholder",
);
