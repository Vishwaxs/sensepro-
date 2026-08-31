/** Proctor review queue: verified backend reads/writes plus Supabase Realtime.
 *  A pending flag is "awaiting review". Nothing here (or anywhere)
 *  auto-decides; every decision remains a staff-authenticated review action. */

import { supabase } from "@/lib/supabase";
import { API_BASE, authHeader } from "@/lib/api";

export type FlagType = "phone" | "extra_person" | "head_pose" | "other";
export type ReviewStatus = "pending" | "dismissed" | "upheld";

export interface ProctorFlagRow {
  id: string;
  session_id: string;
  student_id: string | null; // students.id, when the flag could be attributed
  flag_type: FlagType;
  suppressed: boolean;
  flagged_at: string;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface ExamSessionRow {
  id: string;
  class_section: string;
  subject: string | null;
  mode: "exam";
  starts_at: string;
  ends_at: string | null;
}

export async function fetchExamSessions(limit = 50): Promise<ExamSessionRow[]> {
  const headers = await authHeader();
  const response = await fetch(`${API_BASE}/v1/sessions?limit=${limit}&mode=exam`, { headers });
  if (!response.ok) throw new Error(`Could not load examinations (${response.status})`);
  return ((await response.json()) as ExamSessionRow[]).filter((row) => row.mode === "exam");
}

export async function fetchExamSession(sessionId: string): Promise<ExamSessionRow | null> {
  const rows = await fetchExamSessions();
  return rows.find((row) => row.id === sessionId) ?? null;
}

export async function fetchFlags(sessionId: string): Promise<ProctorFlagRow[]> {
  const headers = await authHeader();
  const response = await fetch(`${API_BASE}/v1/sessions/${sessionId}/proctor-flags`, { headers });
  if (!response.ok) throw new Error(`Could not load proctor events (${response.status})`);
  return (await response.json()) as ProctorFlagRow[];
}

/** A human review. The backend stamps the verified reviewer and server time. */
export async function reviewFlag(
  sessionId: string,
  id: string,
  status: Exclude<ReviewStatus, "pending">,
): Promise<void> {
  const headers = await authHeader();
  const response = await fetch(`${API_BASE}/v1/sessions/${sessionId}/proctor-flags/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ review_status: status }),
  });
  if (response.ok) return;

  let message = `Review failed (${response.status})`;
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) message = payload.detail;
  } catch {
    // Keep the status-based message when the backend did not return JSON.
  }
  throw new Error(message);
}

/** Live queue for one session; returns an unsubscribe fn (same pattern as
 *  subscribePresence). */
export function subscribeFlags(
  sessionId: string,
  onChange: (row: ProctorFlagRow) => void,
  onStatus?: (live: boolean) => void,
): () => void {
  const channel = supabase
    .channel(`proctor-${sessionId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "proctor_flags",
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        const row = payload.new as ProctorFlagRow;
        if (row?.id && !row.suppressed) onChange(row); // DELETE events carry an empty payload.new
      },
    )
    .subscribe((status) => onStatus?.(status === "SUBSCRIBED"));
  return () => {
    void supabase.removeChannel(channel);
  };
}
