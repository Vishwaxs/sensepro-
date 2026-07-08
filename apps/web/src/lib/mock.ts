/** Mock data matching the contract types. Replaced by Supabase reads (RLS)
 *  and the REST endpoints once the Week-2 write-path lands. */

import type {
  AuditEntry,
  CaptureClient,
  ConsentRecord,
  RosterEntry,
  Session,
  ZoneAggregate,
} from "./types";

export const MOCK_SECTION = "MCA-3A";
export const MOCK_SUBJECT = "Distributed Systems";

export const mockRoster: RosterEntry[] = [
  { student_id: "s2547201", name: "Aarav Menon", state: "PRESENT", last_seen_ts: 12, present_seconds: 2640 },
  { student_id: "s2547204", name: "Diya Sharma", state: "PRESENT", last_seen_ts: 8, present_seconds: 2610 },
  { student_id: "s2547209", name: "Ishaan Verma", state: "PRESENT", last_seen_ts: 21, present_seconds: 2455 },
  { student_id: "s2547213", name: "Kavya Nair", state: "UNVERIFIED", last_seen_ts: 96, present_seconds: 2210 },
  { student_id: "s2547218", name: "Mohammed Rafi", state: "PRESENT", last_seen_ts: 15, present_seconds: 2580 },
  { student_id: "s2547222", name: "Nandini Rao", state: "PRESENT", last_seen_ts: 33, present_seconds: 2495 },
  { student_id: "s2547226", name: "Pranav Iyer", state: "ABSENT", last_seen_ts: null, present_seconds: 0 },
  { student_id: "s2547231", name: "Riya Kulkarni", state: "PRESENT", last_seen_ts: 5, present_seconds: 2655 },
  { student_id: "s2547235", name: "Siddharth Bose", state: "UNVERIFIED", last_seen_ts: 132, present_seconds: 1980 },
  { student_id: "s2547240", name: "Tanvi Deshpande", state: "PRESENT", last_seen_ts: 18, present_seconds: 2520 },
  { student_id: "s2547244", name: "Vihaan Reddy", state: "PRESENT", last_seen_ts: 27, present_seconds: 2470 },
  { student_id: "s2547249", name: "Zara Khan", state: "ABSENT", last_seen_ts: null, present_seconds: 340 },
];

export const mockSessions: Session[] = [
  {
    session_id: "ses_0412",
    class_section: MOCK_SECTION,
    subject: MOCK_SUBJECT,
    mode: "attendance",
    started_at: "2026-07-01T09:00:00+05:30",
    ended_at: null,
  },
  {
    session_id: "ses_0411",
    class_section: MOCK_SECTION,
    subject: "Machine Learning",
    mode: "attendance",
    started_at: "2026-06-30T11:00:00+05:30",
    ended_at: "2026-06-30T11:55:00+05:30",
  },
  {
    session_id: "ses_0410",
    class_section: MOCK_SECTION,
    subject: "Distributed Systems",
    mode: "exam",
    started_at: "2026-06-28T14:00:00+05:30",
    ended_at: "2026-06-28T16:00:00+05:30",
  },
];

/** Aggregate-only engagement — zone level, k >= 5 enforced upstream.
 *  The bias story: a naive mean over-counts the visible front rows;
 *  VNEI re-weights by per-zone visibility so every seat counts equally. */
export const mockZones: ZoneAggregate[] = [
  { zone: "front", naive_mean: 0.82, vnei: 0.71, n_visible: 14, suppressed: false },
  { zone: "middle", naive_mean: 0.58, vnei: 0.66, n_visible: 19, suppressed: false },
  { zone: "back", naive_mean: 0.31, vnei: 0.6, n_visible: 9, suppressed: false },
];

export const mockCaptureClients: CaptureClient[] = [
  { device_id: "cap-01", label: "Room 304 smart board", room: "304", last_seen: "2026-07-01T09:42:00+05:30", status: "online" },
  { device_id: "cap-02", label: "Room 210 laptop kiosk", room: "210", last_seen: "2026-06-30T16:05:00+05:30", status: "offline" },
];

/** Every enrolled student has a signed consent record — recognition never runs
 *  without one. Pending-consent students are simply not enrolled yet, so they
 *  do not appear in the roster above. */
export const mockConsent: ConsentRecord[] = mockRoster.map((r) => ({
  student_id: r.student_id,
  name: r.name,
  signed: true,
  signed_on: "2026-06-24",
}));

export const mockAudit: AuditEntry[] = [
  { seq: 1042, action: "presence_interval.close", actor: "system", at: "09:41:07", hash: "9f2c…b41a" },
  { seq: 1041, action: "presence_interval.open", actor: "system", at: "09:40:32", hash: "77aa…03de" },
  { seq: 1040, action: "session.start", actor: "t.rekha", at: "09:00:02", hash: "c58d…91f7" },
  { seq: 1039, action: "consent.record", actor: "admin.vishwas", at: "2026-06-24", hash: "1be0…6c22" },
];

export const mockUsers = [
  { user: "t.rekha", name: "Prof. Rekha S", role: "teacher" as const },
  { user: "m.thomas", name: "Dr. Thomas K", role: "management" as const },
  { user: "admin.vishwas", name: "Vishwas V", role: "admin" as const },
];
