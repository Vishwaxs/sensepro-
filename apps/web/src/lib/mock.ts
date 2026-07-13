/** Seed data for the dashboards before the live Supabase read-path lands.
 *  The roster is the REAL MCA-4B class (from the class list); presence states
 *  here are illustrative placeholders — the live values come from
 *  presence_intervals via Realtime once Phase-2 Prompt 3 is wired. */

import type {
  AuditEntry,
  CaptureClient,
  ConsentRecord,
  RosterEntry,
  Session,
  ZoneAggregate,
} from "./types";

export const MOCK_SECTION = "MCA-4B";
export const MOCK_SUBJECT = "Distributed Systems";

/** Real class roster (reg 2547201–2547262). present_seconds/state/last_seen are
 *  demo placeholders until live presence data replaces them. */
const NAMES: [string, string][] = [
  ["2547201", "Aadharsh Krishnaa G"],
  ["2547203", "Abhinav Jain"],
  ["2547204", "Aimee Susan Joseph"],
  ["2547205", "Ajanya vinayan"],
  ["2547206", "Akashdeep Dey"],
  ["2547208", "Alan Sojan"],
  ["2547209", "Albin Thomas"],
  ["2547210", "Alok Tayal"],
  ["2547211", "Amogh Venkat D"],
  ["2547212", "Anaamika KS"],
  ["2547213", "Angel Blessy"],
  ["2547216", "Annette Elizabeth Shoney"],
  ["2547217", "Annie Neena A.A"],
  ["2547218", "B k Vishnu"],
  ["2547219", "Bhavya Dhanuka"],
  ["2547220", "Dinu Devees George"],
  ["2547221", "Ekta Singh"],
  ["2547222", "Emima J"],
  ["2547223", "Enrita Fernandes"],
  ["2547224", "Evan John Mathew"],
  ["2547225", "Evana Joseph"],
  ["2547226", "Hanna Joshy"],
  ["2547227", "Blessy I"],
  ["2547228", "Jai Pareek"],
  ["2547229", "Karun Nagaraj"],
  ["2547230", "Kuheli Begum"],
  ["2547231", "Kunnal"],
  ["2547232", "Mahamat Tahir Souleymane"],
  ["2547233", "Mohammed Rehan"],
  ["2547234", "Namratha R"],
  ["2547236", "Nirupama Vincent"],
  ["2547237", "Omkaar Chakraborty"],
  ["2547238", "Paavan Gupta"],
  ["2547239", "Prajwal K T"],
  ["2547240", "Pranav MR"],
  ["2547241", "R karan"],
  ["2547242", "Rahul Gupta"],
  ["2547243", "Rishi Raj"],
  ["2547244", "Roy Mathew"],
  ["2547245", "Sachin D"],
  ["2547246", "Saurabh Burnwal"],
  ["2547247", "Sharon Mathew"],
  ["2547249", "SLAVEN DERICK PAIS"],
  ["2547250", "Sneha Varghese"],
  ["2547252", "Sudeepa Santhanam"],
  ["2547254", "Varun Singh"],
  ["2547255", "Vishwas Vashishtha"],
  ["2547256", "Xavier Amith j"],
  ["2547257", "Yash Barjatya"],
  ["2547259", "Ananya M"],
  ["2547260", "Mistry Jamis"],
  ["2547261", "Maniarasan J"],
  ["2547262", "Anushka Singh"],
];

/** Deterministic placeholder presence: most present, a few unverified/absent so
 *  the states, KPIs, and PDF export have realistic variety without randomness. */
export const mockRoster: RosterEntry[] = NAMES.map(([reg, name], i) => {
  const state: RosterEntry["state"] =
    i % 11 === 5 ? "ABSENT" : i % 7 === 3 ? "UNVERIFIED" : "PRESENT";
  return {
    student_id: reg,
    full_name: name,
    state,
    last_seen_ts: state === "ABSENT" ? null : ((i * 7) % 40) + 4,
    present_seconds: state === "ABSENT" ? 0 : 2400 + ((i * 37) % 300),
  };
});

export const mockSessions: Session[] = [
  {
    id: "ses_0412",
    class_section: MOCK_SECTION,
    subject: MOCK_SUBJECT,
    mode: "lecture",
    starts_at: "2026-07-10T09:00:00+05:30",
    ends_at: null,
  },
  {
    id: "ses_0411",
    class_section: MOCK_SECTION,
    subject: "Machine Learning",
    mode: "lecture",
    starts_at: "2026-07-09T11:00:00+05:30",
    ends_at: "2026-07-09T11:55:00+05:30",
  },
  {
    id: "ses_0410",
    class_section: MOCK_SECTION,
    subject: "Distributed Systems",
    mode: "exam",
    starts_at: "2026-07-07T14:00:00+05:30",
    ends_at: "2026-07-07T16:00:00+05:30",
  },
];

/** Aggregate-only engagement — zone level, k >= 5 enforced upstream.
 *  The bias story: a naive mean over-counts the visible front rows;
 *  VNEI re-weights by per-zone visibility so every seat counts equally. */
export const mockZones: ZoneAggregate[] = [
  { zone: "front", naive_mean: 0.82, vnei: 0.71, n_visible: 14, suppressed: false },
  { zone: "mid", naive_mean: 0.58, vnei: 0.66, n_visible: 19, suppressed: false },
  { zone: "back", naive_mean: 0.31, vnei: 0.6, n_visible: 9, suppressed: false },
];

export const mockCaptureClients: CaptureClient[] = [
  { device_id: "cap-01", label: "Room 304 smart board", room: "304", last_seen: "2026-07-10T09:42:00+05:30", status: "online" },
  { device_id: "cap-02", label: "Room 210 laptop kiosk", room: "210", last_seen: "2026-07-09T16:05:00+05:30", status: "offline" },
];

/** Every enrolled student has a signed consent record — recognition never runs
 *  without one. */
export const mockConsent: ConsentRecord[] = mockRoster.map((r) => ({
  student_id: r.student_id,
  name: r.full_name,
  signed: true,
  signed_on: "2026-06-24",
}));

export const mockAudit: AuditEntry[] = [
  { seq: 1042, action: "presence_interval.close", actor: "system", at: "09:41:07", hash: "9f2c…b41a" },
  { seq: 1041, action: "presence_interval.open", actor: "system", at: "09:40:32", hash: "77aa…03de" },
  { seq: 1040, action: "session.start", actor: "neha.singhal", at: "09:00:02", hash: "c58d…91f7" },
  { seq: 1039, action: "consent.record", actor: "admin.vishwas", at: "2026-06-24", hash: "1be0…6c22" },
];

/** Staff accounts — the 4 evaluators are teachers; Rakesh Khanna is management. */
export const mockUsers = [
  { user: "neha.singhal", name: "Dr Neha Singhal", role: "teacher" as const },
  { user: "tegil.john", name: "Dr Tegil J John", role: "teacher" as const },
  { user: "sharmila", name: "Ms. Sharmila", role: "teacher" as const },
  { user: "binayak.dutta", name: "Dr. Binayak Dutta", role: "teacher" as const },
  { user: "rakesh.khanna", name: "Rakesh Khanna", role: "management" as const },
];
