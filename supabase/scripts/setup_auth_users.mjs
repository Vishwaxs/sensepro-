/**
 * One-shot: create the SensePro+ staff auth users and link their app_role.
 *
 * Run this ONCE, locally, with the service-role key in the environment — it is
 * NOT committed anywhere and the key never touches the repo:
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<your ROTATED service-role key> \
 *   node supabase/scripts/setup_auth_users.mjs
 *
 * It is idempotent: re-running updates the password/role rather than erroring.
 *
 * Requires: npm i @supabase/supabase-js  (dev-only; run from apps/web or a temp dir)
 *
 * AFTER running, enable the token hook once (dashboard or Management API):
 *   Authentication > Hooks > Customize Access Token (JWT)
 *   -> select the Postgres function public.custom_access_token_hook
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}

// Shared demo password — REQUIRED from the environment, never a committed
// default (this file lists the real staff emails; a baked-in password would
// hand out working logins to anyone with repo access).
const DEMO_PASSWORD = process.env.SENSEPRO_DEMO_PASSWORD;
if (!DEMO_PASSWORD) {
  console.error("Set SENSEPRO_DEMO_PASSWORD in the environment.");
  process.exit(1);
}

// The 4 evaluators are all teachers; Rakesh Khanna is management.
const USERS = [
  { email: "neha.singhal@sensepro.demo", name: "Dr Neha Singhal", role: "teacher" },
  { email: "tegil.john@sensepro.demo", name: "Dr Tegil J John", role: "teacher" },
  { email: "sharmila@sensepro.demo", name: "Ms. Sharmila", role: "teacher" },
  { email: "binayak.dutta@sensepro.demo", name: "Dr. Binayak Dutta", role: "teacher" },
  { email: "rakesh.khanna@sensepro.demo", name: "Rakesh Khanna", role: "management" },
];

const admin = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserByEmail(email) {
  // Paginate through users (fine for a tiny project).
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

for (const u of USERS) {
  const existing = await findUserByEmail(u.email);
  let userId;
  if (existing) {
    userId = existing.id;
    await admin.auth.admin.updateUserById(userId, {
      password: DEMO_PASSWORD,
      user_metadata: { full_name: u.name },
    });
    console.log(`updated  ${u.email} (${u.role})`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: u.name },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`created  ${u.email} (${u.role})`);
  }

  // Link the role in user_roles — the Access Token Hook reads this on every JWT.
  const { error: upErr } = await admin
    .from("user_roles")
    .upsert({ user_id: userId, app_role: u.role }, { onConflict: "user_id" });
  if (upErr) throw upErr;
}

console.log(`\nDone. All users share password: ${DEMO_PASSWORD}`);
console.log("Remember to enable the custom_access_token_hook (Auth > Hooks) once.");
