/** Live (real Supabase) replacements for the sample-data sections in
 *  admin.tsx / management.tsx / trends.tsx / sessions.tsx.
 *
 * Direct RLS reads, same pattern as roster.ts/proctor.ts/engagement.ts.
 * "Users & roles" is deliberately NOT here: user_roles is revoked from
 * authenticated/anon (migration 0003 — only supabase_auth_admin, the JWT
 * hook, may read it) so a real "who has which role" view needs a service-role
 * admin endpoint, not a client query. Wiring that page honestly (labelled
 * "not yet available") rather than either faking it or granting a client-side
 * read that would undo 0003's deliberate lockdown.
 */

import { supabase } from "@/lib/supabase";
import type { AuditEntry, ConsentRecord, DeletionRequestRow, DeviceRow } from "@/lib/data/types";

interface AggregateMetricRow {
  session_id: string;
  window_start: string;
  zone: string;
  n_tracked: number;
  enrolled_in_zone: number;
  vnei: number;
  coverage: number;
}

interface AggregateSummary {
  vnei: number | null;
  coverage: number | null;
  reportableWindows: number;
  vneiWeight: number;
  coverageWeight: number;
}

/** Summarise reportable zone rows without pretending they are per-person data.
 * If a future pipeline writes a class row for a window, use that row instead of
 * double-counting it alongside its zones. Otherwise VNEI is explicitly weighted
 * by peak-visible count, while coverage is weighted by the configured zone roster. */
function summariseAggregates(rows: AggregateMetricRow[]): AggregateSummary {
  const byWindow = new Map<string, AggregateMetricRow[]>();
  for (const row of rows) {
    const list = byWindow.get(row.window_start) ?? [];
    list.push(row);
    byWindow.set(row.window_start, list);
  }

  const reportRows: AggregateMetricRow[] = [];
  for (const windowRows of byWindow.values()) {
    const classRows = windowRows.filter((row) => row.zone === "class");
    reportRows.push(...(classRows.length > 0 ? classRows : windowRows));
  }

  const visibleWeight = reportRows.reduce((sum, row) => sum + Math.max(row.n_tracked, 0), 0);
  const rosterWeight = reportRows.reduce(
    (sum, row) => sum + Math.max(row.enrolled_in_zone, 0),
    0,
  );
  return {
    vnei:
      visibleWeight > 0
        ? reportRows.reduce(
            (sum, row) => sum + row.vnei * Math.max(row.n_tracked, 0),
            0,
          ) / visibleWeight
        : null,
    coverage:
      rosterWeight > 0
        ? reportRows.reduce(
            (sum, row) => sum + row.coverage * Math.max(row.enrolled_in_zone, 0),
            0,
          ) / rosterWeight
        : null,
    reportableWindows: byWindow.size,
    vneiWeight: visibleWeight,
    coverageWeight: rosterWeight,
  };
}

function summariesBySession(rows: AggregateMetricRow[]): Map<string, AggregateSummary> {
  const grouped = new Map<string, AggregateMetricRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.session_id) ?? [];
    list.push(row);
    grouped.set(row.session_id, list);
  }
  return new Map([...grouped].map(([sessionId, sessionRows]) => [sessionId, summariseAggregates(sessionRows)]));
}

function localDateKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// ---------- devices ----------

const DEVICE_ONLINE_S = 30;
const DEVICE_IDLE_S = 5 * 60;

function deviceStatus(lastSeenAt: string | null): DeviceRow["status"] {
  if (!lastSeenAt) return "offline";
  const ageS = (Date.now() - Date.parse(lastSeenAt)) / 1000;
  if (ageS <= DEVICE_ONLINE_S) return "online";
  if (ageS <= DEVICE_IDLE_S) return "idle";
  return "offline";
}

export async function fetchDevicesLive(): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from("devices")
    .select("id, label, room, last_seen_at")
    .order("label");
  if (error) throw error;
  return (data ?? []).map((d) => ({
    id: d.id,
    label: d.label,
    room: d.room ?? "—",
    last_seen: d.last_seen_at ?? "",
    status: deviceStatus(d.last_seen_at),
  }));
}

// ---------- consent ----------

interface ConsentJoinRow {
  student_id: string;
  consent_version: string;
  signed_at: string;
  withdrawn_at: string | null;
  students: { reg_no: string; full_name: string } | null;
}

export async function fetchConsentsLive(): Promise<ConsentRecord[]> {
  const { data, error } = await supabase
    .from("consent_records")
    .select("student_id, consent_version, signed_at, withdrawn_at, students(reg_no, full_name)")
    .order("signed_at", { ascending: false })
    .returns<ConsentJoinRow[]>();
  if (error) throw error;
  return (data ?? []).map((c) => ({
    student_id: c.student_id,
    name: c.students?.full_name ?? "Unknown",
    reg_no: c.students?.reg_no ?? "—",
    version: c.consent_version,
    signed_at: c.signed_at,
    status: c.withdrawn_at ? "withdrawn" : "active",
  }));
}

// ---------- audit log ----------

export async function fetchAuditLive(limit = 50): Promise<AuditEntry[]> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("seq, at, actor, action, hash, prev_hash")
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((a) => ({
    seq: a.seq,
    ts: a.at,
    actor: a.actor,
    action: a.action,
    hash: a.hash,
    prev_hash: a.prev_hash,
  }));
}

// ---------- deletion requests (migration 0013) ----------

interface DeletionJoinRow {
  id: string;
  student_id: string;
  requested_at: string;
  status: "pending" | "approved" | "denied";
  students: { reg_no: string; full_name: string } | null;
}

export async function fetchDeletionRequestsLive(): Promise<DeletionRequestRow[]> {
  const { data, error } = await supabase
    .from("deletion_requests")
    .select("id, student_id, requested_at, status, students(reg_no, full_name)")
    .order("requested_at", { ascending: false })
    .returns<DeletionJoinRow[]>();
  if (error) throw error;
  return (data ?? []).map((d) => ({
    id: d.id,
    student_id: d.student_id,
    name: d.students?.full_name ?? "Unknown",
    reg_no: d.students?.reg_no ?? "—",
    requested_at: d.requested_at,
    status: d.status,
  }));
}

// ---------- management: recent sessions + a per-session VNEI mean ----------

export interface ManagementSessionRow {
  id: string;
  class_name: string;
  class_section: string;
  mode: "lecture" | "exam" | "workshop";
  started_at: string;
  ended_at: string | null;
  present_count: number;
  total_count: number;
  vnei: number | null; // null (never a fabricated number) until the session has aggregate windows
  coverage: number | null;
  reportable_windows: number;
}

export async function fetchManagementSessions(
  limit = 8,
  mode?: ManagementSessionRow["mode"],
): Promise<ManagementSessionRow[]> {
  let query = supabase
    .from("class_sessions")
    .select("id, class_section, subject, mode, starts_at, ends_at")
    .not("ends_at", "is", null);
  if (mode) query = query.eq("mode", mode);
  const { data: sessions, error } = await query
    .order("starts_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!sessions?.length) return [];

  const lectureSessions = sessions.filter((session) => session.mode === "lecture");
  const workshopSessions = sessions.filter((session) => session.mode === "workshop");
  const presentBySession = new Map<string, Set<string>>();
  if (lectureSessions.length > 0) {
    const { data: presence, error: presenceError } = await supabase
      .from("presence_intervals")
      .select("session_id, student_id")
      .in(
        "session_id",
        lectureSessions.map((session) => session.id),
      )
      .eq("state", "PRESENT");
    if (presenceError) throw presenceError;
    for (const row of presence ?? []) {
      const set = presentBySession.get(row.session_id) ?? new Set<string>();
      set.add(row.student_id);
      presentBySession.set(row.session_id, set);
    }
  }

  const rosterSizeBySection = new Map<string, number>();
  const lectureSections = [...new Set(lectureSessions.map((session) => session.class_section))];
  if (lectureSections.length > 0) {
    const { data: roster, error: rosterError } = await supabase
      .from("students")
      .select("id, class_section")
      .in("class_section", lectureSections);
    if (rosterError) throw rosterError;
    for (const student of roster ?? []) {
      rosterSizeBySection.set(
        student.class_section,
        (rosterSizeBySection.get(student.class_section) ?? 0) + 1,
      );
    }
  }

  let aggregateSummaries = new Map<string, AggregateSummary>();
  if (workshopSessions.length > 0) {
    const { data: zones, error: zoneError } = await supabase
      .from("engagement_zone_aggregates")
      .select("session_id, window_start, zone, n_tracked, enrolled_in_zone, vnei, coverage")
      .in(
        "session_id",
        workshopSessions.map((session) => session.id),
      )
      .returns<AggregateMetricRow[]>();
    if (zoneError) throw zoneError;
    aggregateSummaries = summariesBySession(zones ?? []);
  }

  return sessions.map((s) => {
    const aggregate = aggregateSummaries.get(s.id);
    return {
      id: s.id,
      class_name: s.subject ?? s.class_section,
      class_section: s.class_section,
      mode: s.mode as ManagementSessionRow["mode"],
      started_at: s.starts_at,
      ended_at: s.ends_at,
      present_count: presentBySession.get(s.id)?.size ?? 0,
      total_count: rosterSizeBySection.get(s.class_section) ?? 0,
      vnei: aggregate?.vnei ?? null,
      coverage: aggregate?.coverage ?? null,
      reportable_windows: aggregate?.reportableWindows ?? 0,
    };
  });
}

// ---------- trends: same session set, folded into a per-day series ----------

export interface TrendPoint {
  date: string; // yyyy-mm-dd, the session's local day
  label: string; // d/m for the chart axis
  attendance: number | null; // present/total, null when total is 0 (never fabricated)
  vnei: number | null; // null when no aggregate windows exist for that day yet
  coverage: number | null; // null when no reportable engagement window exists
}

export async function fetchTrendSeries(
  days = 14,
  mode?: "lecture" | "exam" | "workshop",
): Promise<TrendPoint[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let query = supabase
    .from("class_sessions")
    .select("id, class_section, starts_at, ends_at")
    .not("ends_at", "is", null)
    .gte("starts_at", since);
  if (mode) query = query.eq("mode", mode);
  const { data: sessions, error } = await query.order("starts_at", { ascending: true });
  if (error) throw error;
  if (!sessions?.length) return [];

  const ids = sessions.map((s) => s.id);
  const sections = [...new Set(sessions.map((s) => s.class_section))];

  const [
    { data: presence, error: presErr },
    { data: zones, error: zoneErr },
    { data: roster, error: rosterErr },
  ] = await Promise.all([
    supabase
      .from("presence_intervals")
      .select("session_id, student_id")
      .in("session_id", ids)
      .eq("state", "PRESENT"),
    supabase
      .from("engagement_zone_aggregates")
      .select("session_id, vnei, coverage")
      .in("session_id", ids),
    supabase.from("students").select("id, class_section").in("class_section", sections),
  ]);
  if (presErr) throw presErr;
  if (zoneErr) throw zoneErr;
  if (rosterErr) throw rosterErr;

  const presentBySession = new Map<string, Set<string>>();
  for (const p of presence ?? []) {
    const set = presentBySession.get(p.session_id) ?? new Set<string>();
    set.add(p.student_id);
    presentBySession.set(p.session_id, set);
  }
  const vneiBySession = new Map<string, number[]>();
  const coverageBySession = new Map<string, number[]>();
  for (const z of zones ?? []) {
    const list = vneiBySession.get(z.session_id) ?? [];
    list.push(z.vnei);
    vneiBySession.set(z.session_id, list);
    const coverage = coverageBySession.get(z.session_id) ?? [];
    coverage.push(z.coverage);
    coverageBySession.set(z.session_id, coverage);
  }
  const rosterSizeBySection = new Map<string, number>();
  for (const s of roster ?? []) {
    rosterSizeBySection.set(s.class_section, (rosterSizeBySection.get(s.class_section) ?? 0) + 1);
  }

  // One row per session first, then fold same-day sessions together.
  const byDay = new Map<
    string,
    { present: number; total: number; vnei: number[]; coverage: number[] }
  >();
  for (const s of sessions) {
    const day = s.starts_at.slice(0, 10);
    const entry = byDay.get(day) ?? { present: 0, total: 0, vnei: [], coverage: [] };
    entry.present += presentBySession.get(s.id)?.size ?? 0;
    entry.total += rosterSizeBySection.get(s.class_section) ?? 0;
    entry.vnei.push(...(vneiBySession.get(s.id) ?? []));
    entry.coverage.push(...(coverageBySession.get(s.id) ?? []));
    byDay.set(day, entry);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => {
      const d = new Date(day);
      return {
        date: day,
        label: `${d.getDate()}/${d.getMonth() + 1}`,
        attendance: v.total > 0 ? v.present / v.total : null,
        vnei: v.vnei.length ? v.vnei.reduce((a, b) => a + b, 0) / v.vnei.length : null,
        coverage: v.coverage.length
          ? v.coverage.reduce((a, b) => a + b, 0) / v.coverage.length
          : null,
      };
    });
}

// ---------- sessions history page ----------

export interface SessionHistoryRow {
  id: string;
  class_section: string;
  subject: string | null;
  mode: "lecture" | "exam" | "workshop";
  starts_at: string;
  ends_at: string | null;
  present_count: number;
  total_count: number;
  flag_count: number;
  pending_flag_count: number;
  vnei: number | null;
  coverage: number | null;
  reportable_windows: number;
}

export async function fetchSessionsLive(limit = 50): Promise<SessionHistoryRow[]> {
  const { data: sessions, error } = await supabase
    .from("class_sessions")
    .select("id, class_section, subject, mode, starts_at, ends_at")
    .order("starts_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!sessions?.length) return [];

  const ids = sessions.map((s) => s.id);
  const sections = [...new Set(sessions.map((s) => s.class_section))];

  const [
    { data: presence, error: presErr },
    { data: roster, error: rosterErr },
    { data: flags, error: flagErr },
    { data: zones, error: zoneErr },
  ] = await Promise.all([
    supabase
      .from("presence_intervals")
      .select("session_id, student_id")
      .in("session_id", ids)
      .eq("state", "PRESENT"),
    supabase.from("students").select("id, class_section").in("class_section", sections),
    supabase.from("proctor_flags").select("session_id, review_status").in("session_id", ids),
    supabase
      .from("engagement_zone_aggregates")
      .select("session_id, window_start, vnei, coverage")
      .in("session_id", ids),
  ]);
  if (presErr) throw presErr;
  if (rosterErr) throw rosterErr;
  if (flagErr) throw flagErr;
  if (zoneErr) throw zoneErr;

  const presentBySession = new Map<string, Set<string>>();
  for (const p of presence ?? []) {
    const set = presentBySession.get(p.session_id) ?? new Set<string>();
    set.add(p.student_id);
    presentBySession.set(p.session_id, set);
  }
  const rosterSizeBySection = new Map<string, number>();
  for (const s of roster ?? []) {
    rosterSizeBySection.set(s.class_section, (rosterSizeBySection.get(s.class_section) ?? 0) + 1);
  }

  const flagCountBySession = new Map<string, number>();
  const pendingFlagCountBySession = new Map<string, number>();
  for (const flag of flags ?? []) {
    flagCountBySession.set(flag.session_id, (flagCountBySession.get(flag.session_id) ?? 0) + 1);
    if (flag.review_status === "pending") {
      pendingFlagCountBySession.set(
        flag.session_id,
        (pendingFlagCountBySession.get(flag.session_id) ?? 0) + 1,
      );
    }
  }

  const vneiBySession = new Map<string, number[]>();
  const coverageBySession = new Map<string, number[]>();
  const windowsBySession = new Map<string, Set<string>>();
  for (const zone of zones ?? []) {
    const values = vneiBySession.get(zone.session_id) ?? [];
    values.push(zone.vnei);
    vneiBySession.set(zone.session_id, values);
    const coverage = coverageBySession.get(zone.session_id) ?? [];
    coverage.push(zone.coverage);
    coverageBySession.set(zone.session_id, coverage);
    const windows = windowsBySession.get(zone.session_id) ?? new Set<string>();
    windows.add(zone.window_start);
    windowsBySession.set(zone.session_id, windows);
  }

  return sessions.map((s) => {
    const vnei = vneiBySession.get(s.id);
    const coverage = coverageBySession.get(s.id);
    return {
      id: s.id,
      class_section: s.class_section,
      subject: s.subject,
      mode: s.mode as SessionHistoryRow["mode"],
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      present_count: presentBySession.get(s.id)?.size ?? 0,
      total_count: rosterSizeBySection.get(s.class_section) ?? 0,
      flag_count: flagCountBySession.get(s.id) ?? 0,
      pending_flag_count: pendingFlagCountBySession.get(s.id) ?? 0,
      vnei: vnei?.length ? vnei.reduce((a, b) => a + b, 0) / vnei.length : null,
      coverage: coverage?.length ? coverage.reduce((a, b) => a + b, 0) / coverage.length : null,
      reportable_windows: windowsBySession.get(s.id)?.size ?? 0,
    };
  });
}
