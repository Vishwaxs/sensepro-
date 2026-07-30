import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || "https://bwjrnkledjjpcvnzykqc.supabase.co";
const KEY = process.env.SUPABASE_SECRET_KEY || "";

if (!KEY) {
  console.error("Set SUPABASE_SECRET_KEY in the environment.");
  process.exit(1);
}

const admin = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const ACCOUNTS = [
  {
    email: "teacher@sensepro.demo",
    password: process.env.SENSEPRO_DEMO_PASSWORD || "Password123!",
    role: "teacher",
    name: "Dr. Ramesh Rao",
  },
  {
    email: "management@sensepro.demo",
    password: process.env.SENSEPRO_DEMO_PASSWORD || "Password123!",
    role: "management",
    name: "Dean Suresh Iyer",
  },
  {
    email: "admin@sensepro.demo",
    password: process.env.SENSEPRO_DEMO_PASSWORD || "Password123!",
    role: "admin",
    name: "Admin Ops",
  },
  {
    email: "student@sensepro.demo",
    password: process.env.SENSEPRO_DEMO_PASSWORD || "Password123!",
    role: "student",
    name: "Demo Student",
  },
];

async function main() {
  const { data: listData, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) {
    console.error("List users error:", listErr);
    process.exit(1);
  }

  for (const acc of ACCOUNTS) {
    let existing = listData.users.find((u) => u.email === acc.email);
    let userId;

    if (existing) {
      userId = existing.id;
      console.log(`Updating ${acc.email} (${acc.role})...`);
      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
        password: acc.password,
        email_confirm: true,
        user_metadata: { full_name: acc.name },
      });
      if (updateErr) console.error("Update error:", updateErr);
    } else {
      console.log(`Creating ${acc.email} (${acc.role})...`);
      const { data: createData, error: createErr } = await admin.auth.admin.createUser({
        email: acc.email,
        password: acc.password,
        email_confirm: true,
        user_metadata: { full_name: acc.name },
      });
      if (createErr) {
        console.error("Create error:", createErr);
        continue;
      }
      userId = createData.user.id;
    }

    const { error: roleErr } = await admin
      .from("user_roles")
      .upsert({ user_id: userId, app_role: acc.role }, { onConflict: "user_id" });
    if (roleErr) console.error("Role assign error:", roleErr);

    if (acc.role === "student") {
      // Ensure student row exists & links auth_uid
      const { data: stData } = await admin
        .from("students")
        .select("id")
        .eq("reg_no", "2547201")
        .maybeSingle();
      if (stData) {
        await admin.from("students").update({ auth_uid: userId }).eq("id", stData.id);
      }
    }
  }

  console.log("\n✅ All 4 role accounts configured!");
}

main();
