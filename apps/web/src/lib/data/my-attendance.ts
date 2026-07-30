/**
 * Real Supabase queries for the /me student self-view.
 *
 * Relies on RLS policies:
 *  - "students self read":  auth_uid = auth.uid()
 *  - "presence self read":  student_id links to a student with auth_uid = auth.uid()
 *
 * The query never exposes another student's data — RLS enforces scoping.
 */

import { supabase } from "@/lib/supabase/client";
import type { AttendanceState } from "@/lib/data/types";

export interface MyAttendanceRow {
  session_id: string;
  class_name: string; // class_sessions.subject ?? class_sessions.class_section
  date: string; // class_sessions.starts_at ISO string
  state: AttendanceState;
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
  | { status: "empty"; student: MyStudentProfile } // linked but no attendance yet
  | { status: "ok"; student: MyStudentProfile; records: MyAttendanceRow[] }
  | { status: "error"; message: string };

/** Fetch the signed-in user's student profile (or null if not linked). */
async function fetchMyStudent(): Promise<MyStudentProfile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

/** Fetch the signed-in student's attendance history (most recent first). */
export async function fetchMyAttendance(): Promise<MyAttendanceResult> {
  try {
    const student = await fetchMyStudent();
    if (!student) return { status: "no-student" };

    // RLS "presence self read" ensures we only get rows where
    // student_id belongs to a student with auth_uid = auth.uid()
    const { data, error } = await supabase
      .from("presence_intervals")
      .select(
        `
        id,
        session_id,
        state,
        started_at,
        class_sessions!inner (
          id,
          subject,
          class_section,
          starts_at
        )
      `,
      )
      .eq("student_id", student.id)
      .order("started_at", { ascending: false })
      .limit(100);

    if (error) throw new Error(`Failed to fetch attendance: ${error.message}`);

    if (!data || data.length === 0) {
      return { status: "empty", student };
    }

    // Deduplicate by session — take the latest state per session
    const bySession = new Map<string, MyAttendanceRow>();
    for (const row of data) {
      const cs = row.class_sessions as unknown as {
        id: string;
        subject: string | null;
        class_section: string;
        starts_at: string;
      };
      const sid = row.session_id;
      if (!bySession.has(sid)) {
        bySession.set(sid, {
          session_id: sid,
          class_name: cs.subject ?? cs.class_section,
          date: cs.starts_at,
          state: row.state as AttendanceState,
        });
      }
    }

    const records = Array.from(bySession.values());
    return { status: "ok", student, records };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { status: "error", message: msg };
  }
}
