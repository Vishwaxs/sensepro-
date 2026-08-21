/**
 * Real Supabase queries for the /me student self-view.
 *
 * Relies on RLS policies:
 *  - "students self read":         auth_uid = auth.uid()
 *  - "presence self read":         student_id links to a student with auth_uid = auth.uid()
 *  - "sessions student read own section" (migration 0011): class_section
 *    matches the student's own class_section
 *
 * The query never exposes another student's data — RLS enforces scoping.
 */

import { supabase, supabaseAuth } from "@/lib/supabase/client";
import type { AttendanceState } from "@/lib/data/types";

export type SessionMode = "lecture" | "exam" | "workshop";

export interface MyAttendanceRow {
  session_id: string;
  class_name: string; // class_sessions.subject ?? class_sessions.class_section
  date: string; // class_sessions.starts_at ISO string
  state: AttendanceState;
  mode: SessionMode;
  live: boolean; // ends_at is still null
}

export interface MyStudentProfile {
  id: string;
  full_name: string;
  reg_no: string;
  class_section: string;
}

export type MyAttendanceResult =
  | { status: "loading" }
  | { status: "no-student" } // auth user isn't linked to a student row
  | { status: "empty"; student: MyStudentProfile } // linked but no sessions have run yet
  | { status: "ok"; student: MyStudentProfile; records: MyAttendanceRow[] }
  | { status: "error"; message: string };

/** Fetch the signed-in user's student profile (or null if not linked). */
async function fetchMyStudent(): Promise<MyStudentProfile | null> {
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) return null;

  // RLS "students self read" scopes to auth_uid = auth.uid()
  const { data, error } = await supabase
    .from("students")
    .select("id, full_name, reg_no, class_section")
    .eq("auth_uid", user.id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch student profile: ${error.message}`);
  return data as MyStudentProfile | null;
}

/** Fetch the signed-in student's attendance history (most recent first).
 *
 * Reads every class_sessions row for the student's own class_section (not
 * just the ones with a presence_intervals row) and left-merges the student's
 * own presence state onto each — a session with NO presence row for this
 * student defaults to ABSENT rather than silently disappearing, so a fully
 * absent student's real history is shown, not hidden. */
export async function fetchMyAttendance(): Promise<MyAttendanceResult> {
  try {
    const student = await fetchMyStudent();
    if (!student) return { status: "no-student" };

    const { data: sessions, error: sessErr } = await supabase
      .from("class_sessions")
      .select("id, subject, class_section, mode, starts_at, ends_at")
      .eq("class_section", student.class_section)
      .order("starts_at", { ascending: false })
      .limit(100);
    if (sessErr) throw new Error(`Failed to fetch sessions: ${sessErr.message}`);

    if (!sessions || sessions.length === 0) {
      return { status: "empty", student };
    }

    // RLS "presence self read" ensures we only get rows where
    // student_id belongs to a student with auth_uid = auth.uid()
    const sessionIds = sessions.map((s) => s.id);
    const { data: intervals, error: presErr } = await supabase
      .from("presence_intervals")
      .select("session_id, state, started_at")
      .eq("student_id", student.id)
      .in("session_id", sessionIds)
      .order("started_at", { ascending: false });
    if (presErr) throw new Error(`Failed to fetch attendance: ${presErr.message}`);

    // Latest interval per session (intervals are newest-first already).
    const latestBySession = new Map<string, AttendanceState>();
    for (const iv of intervals ?? []) {
      if (!latestBySession.has(iv.session_id)) {
        latestBySession.set(iv.session_id, iv.state as AttendanceState);
      }
    }

    const records: MyAttendanceRow[] = sessions.map((s) => ({
      session_id: s.id,
      class_name: s.subject ?? s.class_section,
      date: s.starts_at,
      state: latestBySession.get(s.id) ?? "ABSENT",
      mode: s.mode as SessionMode,
      live: s.ends_at === null,
    }));

    return { status: "ok", student, records };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { status: "error", message: msg };
  }
}

export interface MyConsent {
  version: string;
  signed_at: string;
  status: "active" | "withdrawn";
}

/** The signed-in student's own consent record (most recent), or null if
 * they're not linked to a student row or have none on file yet. */
export async function fetchMyConsent(): Promise<MyConsent | null> {
  const student = await fetchMyStudent();
  if (!student) return null;

  // RLS "consent self read" scopes to a student with auth_uid = auth.uid()
  const { data, error } = await supabase
    .from("consent_records")
    .select("consent_version, signed_at, withdrawn_at")
    .eq("student_id", student.id)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch consent: ${error.message}`);
  if (!data) return null;
  return {
    version: data.consent_version,
    signed_at: data.signed_at,
    status: data.withdrawn_at ? "withdrawn" : "active",
  };
}
