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
import { API_BASE, authHeader } from "@/lib/api";
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
  const rosterWeight = reportRows.reduce((sum, row) => sum + Math.max(row.enrolled_in_zone, 0), 0);
  return {
    vnei:
      visibleWeight > 0
        ? reportRows.reduce((sum, row) => sum + row.vnei * Math.max(row.n_tracked, 0), 0) /
          visibleWeight
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
  return new Map(
    [...grouped].map(([sessionId, sessionRows]) => [sessionId, summariseAggregates(sessionRows)]),
  );
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
  try {
    const headers = await authHeader();
    const url = mode
      ? `${API_BASE}/v1/sessions?limit=${limit}&mode=${mode}`
      : `${API_BASE}/v1/sessions?limit=${limit}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const rows = (await res.json()) as SessionHistoryRow[];
      return rows
        .filter((r) => r.ends_at !== null && (!mode || r.mode === mode))
        .map((r) => ({
          id: r.id,
          class_name: r.subject ?? r.class_section,
          class_section: r.class_section,
          mode: r.mode,
          started_at: r.starts_at,
          ended_at: r.ends_at,
          present_count: r.present_count,
          total_count: r.total_count,
          vnei: r.vnei,
          coverage: r.coverage,
          reportable_windows: r.reportable_windows,
        }));
    }
  } catch {
    /* fallback to direct Supabase */
  }

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

  if (mode === "workshop") {
    const headers = await authHeader();
    const response = await fetch(`${API_BASE}/v1/sessions?limit=500&mode=workshop`, { headers });
    if (response.ok) {
      const sessions = ((await response.json()) as SessionHistoryRow[]).filter(
        (session) => session.ends_at !== null && session.starts_at >= since,
      );
      const byDay = new Map<
        string,
        {
          vneiWeighted: number;
          vneiWeight: number;
          coverageWeighted: number;
          coverageWeight: number;
        }
      >();
      for (const session of sessions) {
        const day = localDateKey(session.starts_at);
        const entry = byDay.get(day) ?? {
          vneiWeighted: 0,
          vneiWeight: 0,
          coverageWeighted: 0,
          coverageWeight: 0,
        };
        const vneiWeight = session.vnei_weight ?? session.reportable_windows;
        const coverageWeight = session.coverage_weight ?? session.reportable_windows;
        if (session.vnei !== null && vneiWeight > 0) {
          entry.vneiWeighted += session.vnei * vneiWeight;
          entry.vneiWeight += vneiWeight;
        }
        if (session.coverage !== null && coverageWeight > 0) {
          entry.coverageWeighted += session.coverage * coverageWeight;
          entry.coverageWeight += coverageWeight;
        }
        byDay.set(day, entry);
      }
      return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, value]) => {
          const [, month, date] = day.split("-");
          return {
            date: day,
            label: `${Number(date)}/${Number(month)}`,
            attendance: null,
            vnei: value.vneiWeight > 0 ? value.vneiWeighted / value.vneiWeight : null,
            coverage:
              value.coverageWeight > 0 ? value.coverageWeighted / value.coverageWeight : null,
          };
        });
    }
  }

  let query = supabase
    .from("class_sessions")
    .select("id, class_section, mode, starts_at, ends_at")
    .not("ends_at", "is", null)
    .gte("starts_at", since);
  if (mode) query = query.eq("mode", mode);
  const { data: sessions, error } = await query.order("starts_at", { ascending: true });
  if (error) throw error;
  if (!sessions?.length) return [];

  const lectureSessions = sessions.filter((session) => session.mode === "lecture");
  const workshopSessions = sessions.filter((session) => session.mode === "workshop");

  const presentBySession = new Map<string, Set<string>>();
  const rosterSizeBySection = new Map<string, number>();
  if (lectureSessions.length > 0) {
    const lectureIds = lectureSessions.map((session) => session.id);
    const lectureSections = [...new Set(lectureSessions.map((session) => session.class_section))];
    const [{ data: presence, error: presenceError }, { data: roster, error: rosterError }] =
      await Promise.all([
        supabase
          .from("presence_intervals")
          .select("session_id, student_id")
          .in("session_id", lectureIds)
          .eq("state", "PRESENT"),
        supabase.from("students").select("id, class_section").in("class_section", lectureSections),
      ]);
    if (presenceError) throw presenceError;
    if (rosterError) throw rosterError;
    for (const row of presence ?? []) {
      const set = presentBySession.get(row.session_id) ?? new Set<string>();
      set.add(row.student_id);
      presentBySession.set(row.session_id, set);
    }
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

  const byDay = new Map<
    string,
    {
      present: number;
      total: number;
      vneiWeighted: number;
      vneiWeight: number;
      coverageWeighted: number;
      coverageWeight: number;
    }
  >();
  for (const session of sessions) {
    const day = localDateKey(session.starts_at);
    const entry = byDay.get(day) ?? {
      present: 0,
      total: 0,
      vneiWeighted: 0,
      vneiWeight: 0,
      coverageWeighted: 0,
      coverageWeight: 0,
    };

    if (session.mode === "lecture") {
      entry.present += presentBySession.get(session.id)?.size ?? 0;
      entry.total += rosterSizeBySection.get(session.class_section) ?? 0;
    }

    const aggregate = aggregateSummaries.get(session.id);
    if (aggregate?.vnei !== null && aggregate?.vnei !== undefined) {
      entry.vneiWeighted += aggregate.vnei * aggregate.vneiWeight;
      entry.vneiWeight += aggregate.vneiWeight;
    }
    if (aggregate?.coverage !== null && aggregate?.coverage !== undefined) {
      entry.coverageWeighted += aggregate.coverage * aggregate.coverageWeight;
      entry.coverageWeight += aggregate.coverageWeight;
    }
    byDay.set(day, entry);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => {
      const [, month, date] = day.split("-");
      return {
        date: day,
        label: `${Number(date)}/${Number(month)}`,
        attendance: value.total > 0 ? value.present / value.total : null,
        vnei: value.vneiWeight > 0 ? value.vneiWeighted / value.vneiWeight : null,
        coverage: value.coverageWeight > 0 ? value.coverageWeighted / value.coverageWeight : null,
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
  vnei_weight?: number;
  coverage_weight?: number;
}

export async function fetchSessionsLive(limit = 50): Promise<SessionHistoryRow[]> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${API_BASE}/v1/sessions?limit=${limit}`, { headers });
    if (res.ok) {
      return (await res.json()) as SessionHistoryRow[];
    }
  } catch {
    /* fallback to direct Supabase query */
  }

  const { data: sessions, error } = await supabase
    .from("class_sessions")
    .select("id, class_section, subject, mode, starts_at, ends_at")
    .order("starts_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!sessions?.length) return [];

  const lectureSessions = sessions.filter((session) => session.mode === "lecture");
  const examSessions = sessions.filter((session) => session.mode === "exam");
  const workshopSessions = sessions.filter((session) => session.mode === "workshop");

  const presentBySession = new Map<string, Set<string>>();
  const rosterSizeBySection = new Map<string, number>();
  if (lectureSessions.length > 0) {
    const lectureIds = lectureSessions.map((session) => session.id);
    const lectureSections = [...new Set(lectureSessions.map((session) => session.class_section))];
    const [{ data: presence, error: presenceError }, { data: roster, error: rosterError }] =
      await Promise.all([
        supabase
          .from("presence_intervals")
          .select("session_id, student_id")
          .in("session_id", lectureIds)
          .eq("state", "PRESENT"),
        supabase.from("students").select("id, class_section").in("class_section", lectureSections),
      ]);
    if (presenceError) throw presenceError;
    if (rosterError) throw rosterError;
    for (const row of presence ?? []) {
      const set = presentBySession.get(row.session_id) ?? new Set<string>();
      set.add(row.student_id);
      presentBySession.set(row.session_id, set);
    }
    for (const student of roster ?? []) {
      rosterSizeBySection.set(
        student.class_section,
        (rosterSizeBySection.get(student.class_section) ?? 0) + 1,
      );
    }
  }

  const flagCountBySession = new Map<string, number>();
  const pendingFlagCountBySession = new Map<string, number>();
  if (examSessions.length > 0) {
    const { data: flags, error: flagError } = await supabase
      .from("proctor_flags")
      .select("session_id, review_status")
      .in(
        "session_id",
        examSessions.map((session) => session.id),
      );
    if (flagError) throw flagError;
    for (const flag of flags ?? []) {
      flagCountBySession.set(flag.session_id, (flagCountBySession.get(flag.session_id) ?? 0) + 1);
      if (flag.review_status === "pending") {
        pendingFlagCountBySession.set(
          flag.session_id,
          (pendingFlagCountBySession.get(flag.session_id) ?? 0) + 1,
        );
      }
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
      class_section: s.class_section,
      subject: s.subject,
      mode: s.mode as SessionHistoryRow["mode"],
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      present_count: s.mode === "lecture" ? (presentBySession.get(s.id)?.size ?? 0) : 0,
      total_count: s.mode === "lecture" ? (rosterSizeBySection.get(s.class_section) ?? 0) : 0,
      flag_count: s.mode === "exam" ? (flagCountBySession.get(s.id) ?? 0) : 0,
      pending_flag_count: s.mode === "exam" ? (pendingFlagCountBySession.get(s.id) ?? 0) : 0,
      vnei: s.mode === "workshop" ? (aggregate?.vnei ?? null) : null,
      coverage: s.mode === "workshop" ? (aggregate?.coverage ?? null) : null,
      reportable_windows: s.mode === "workshop" ? (aggregate?.reportableWindows ?? 0) : 0,
    };
  });
}
