import type {
  AttendanceRecord,
  AuditEntry,
  ConsentRecord,
  DeviceRow,
  ProctorFlag,
  RosterEntry,
  Session,
  UserRow,
  ZoneAggregate,
} from "./types";

const INDIAN_NAMES = [
  "Aarav Sharma",
  "Diya Patel",
  "Ishaan Nair",
  "Ananya Reddy",
  "Vihaan Iyer",
  "Meera Krishnan",
  "Kabir Menon",
  "Saanvi Rao",
  "Arjun Chatterjee",
  "Riya Bose",
  "Rohan Gupta",
  "Priya Balakrishnan",
  "Aditya Verma",
  "Neha Deshpande",
  "Krishna Pillai",
  "Sneha Joshi",
  "Aryan Malhotra",
  "Kavya Subramanian",
  "Devansh Kulkarni",
  "Aisha Khan",
  "Yash Agarwal",
  "Tanvi Bhatt",
  "Shaurya Mehta",
  "Anika Ghosh",
  "Reyansh Kapoor",
  "Ira Sundaram",
  "Advait Chowdhury",
  "Myra Bhattacharya",
  "Vivaan Naidu",
  "Zara Ansari",
  "Karthik Raman",
  "Pooja Varghese",
  "Nikhil Saxena",
  "Aditi Prasad",
  "Om Trivedi",
];

const REG_PREFIX = "23MCA";

export function mockRoster(): RosterEntry[] {
  // SWAP: supabase query — select roster for active session
  return INDIAN_NAMES.map((name, i) => {
    const roll = 1001 + i;
    const r = Math.random();
    const state: RosterEntry["state"] = r < 0.62 ? "PRESENT" : r < 0.82 ? "UNVERIFIED" : "ABSENT";
    return {
      student_id: `s_${roll}`,
      name,
      reg_no: `${REG_PREFIX}${roll}`,
      state,
      last_seen:
        state === "PRESENT"
          ? new Date(Date.now() - Math.floor(Math.random() * 180_000)).toISOString()
          : null,
    };
  });
}

export function mockSessions(): Session[] {
  // SWAP: supabase query — recent sessions
  const now = Date.now();
  const classes = [
    "MCA-II · Distributed Systems",
    "MCA-II · Machine Learning",
    "MCA-I · Data Structures",
    "MCA-II · Cloud Native",
    "MCA-I · DBMS",
  ];
  return classes.map((c, i) => ({
    id: `sess_${i + 1}`,
    class_name: c,
    room: `Room ${201 + i}`,
    started_at: new Date(now - (i + 1) * 3600_000).toISOString(),
    ended_at: i === 0 ? null : new Date(now - (i + 1) * 3600_000 + 55 * 60_000).toISOString(),
    present_count: 22 + Math.floor(Math.random() * 10),
    total_count: 35,
    vnei: 0.58 + Math.random() * 0.28,
  }));
}

export function mockFlags(): ProctorFlag[] {
  // SWAP: supabase query — flags for sessions the teacher owns
  const now = Date.now();
  const types: ProctorFlag["type"][] = ["phone", "extra_person", "head_pose"];
  return Array.from({ length: 6 }).map((_, i) => ({
    id: `flag_${i + 1}`,
    session_id: `sess_${(i % 3) + 1}`,
    type: types[i % 3],
    ts: new Date(now - i * 12 * 60_000).toISOString(),
    clip_seconds: 6 + (i % 4),
    status: "awaiting_review",
  }));
}

export function mockZones(): ZoneAggregate[] {
  // SWAP: supabase query — aggregated per session
  return [
    { zone: "front", vnei: 0.74, naive_mean: 0.81, coverage: 0.82, n_tracked: 12, n_visible: 12 },
    { zone: "mid", vnei: 0.61, naive_mean: 0.68, coverage: 0.67, n_tracked: 10, n_visible: 10 },
    { zone: "back", vnei: 0.38, naive_mean: 0.52, coverage: 0.41, n_tracked: 4, n_visible: 4 },
  ];
}

export function mockVneiTrend() {
  // SWAP: supabase query — VNEI over last N sessions
  return Array.from({ length: 10 }).map((_, i) => ({
    session: `S-${i + 1}`,
    vnei: +(0.5 + Math.sin(i / 1.7) * 0.15 + Math.random() * 0.08).toFixed(2),
  }));
}

export function mockConsents(): ConsentRecord[] {
  // SWAP: supabase query — consent registry
  return INDIAN_NAMES.slice(0, 20).map((name, i) => ({
    student_id: `s_${1001 + i}`,
    name,
    reg_no: `${REG_PREFIX}${1001 + i}`,
    version: "v2.1",
    signed_at: new Date(Date.now() - i * 86400_000).toISOString(),
    status: i === 7 ? "withdrawn" : "active",
  }));
}

export function mockAudit(): AuditEntry[] {
  // SWAP: supabase query — audit log with hash chain
  const actions = [
    "session.start",
    "session.end",
    "roster.export",
    "flag.dismiss",
    "flag.uphold",
    "consent.sign",
    "user.role.grant",
    "deletion.request",
  ];
  const entries: AuditEntry[] = [];
  let prev = "000000000000";
  for (let i = 0; i < 14; i++) {
    const hash = randHash();
    entries.push({
      seq: 1000 + i,
      ts: new Date(Date.now() - (13 - i) * 7 * 60_000).toISOString(),
      actor: i % 3 === 0 ? "sys" : i % 3 === 1 ? "t.rao@campus" : "admin@campus",
      action: actions[i % actions.length],
      hash,
      prev_hash: prev,
    });
    prev = hash;
  }
  // newest first
  return entries.reverse();
}

export function mockDevices(): DeviceRow[] {
  // SWAP: supabase query — capture clients
  return [
    {
      id: "cap_201",
      label: "Board · Room 201",
      room: "Room 201",
      last_seen: new Date(Date.now() - 12_000).toISOString(),
      status: "online",
    },
    {
      id: "cap_202",
      label: "Board · Room 202",
      room: "Room 202",
      last_seen: new Date(Date.now() - 90_000).toISOString(),
      status: "idle",
    },
    {
      id: "cap_204",
      label: "Board · Room 204",
      room: "Room 204",
      last_seen: new Date(Date.now() - 20 * 60_000).toISOString(),
      status: "offline",
    },
    {
      id: "cap_lab1",
      label: "Lab-1 Kiosk",
      room: "Lab 1",
      last_seen: new Date(Date.now() - 6_000).toISOString(),
      status: "online",
    },
  ];
}

export function mockUsers(): UserRow[] {
  // SWAP: supabase query — users + roles
  return [
    { id: "u1", name: "Dr. Ramesh Rao", email: "r.rao@campus", role: "teacher" },
    { id: "u2", name: "Prof. Kavitha Nair", email: "k.nair@campus", role: "teacher" },
    { id: "u3", name: "Dean Suresh Iyer", email: "s.iyer@campus", role: "management" },
    { id: "u4", name: "Admin Ops", email: "admin@campus", role: "admin" },
  ];
}

export function mockMyAttendance(): AttendanceRecord[] {
  // SWAP: supabase query — /me attendance
  const now = Date.now();
  return Array.from({ length: 28 }).map((_, i) => {
    const r = Math.random();
    const state = r < 0.75 ? "PRESENT" : r < 0.9 ? "UNVERIFIED" : "ABSENT";
    return {
      session_id: `sess_${i}`,
      class_name: ["Distributed Systems", "Machine Learning", "Cloud Native", "DBMS"][i % 4],
      date: new Date(now - i * 86400_000).toISOString(),
      state,
    };
  });
}

function randHash() {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}
