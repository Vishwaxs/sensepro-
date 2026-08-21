/** Presence writes that go through the backend (service role), not a direct
 *  Supabase client write: presence_intervals has no client insert/update
 *  policy (migration 0002 — only the vision pipeline writes it).
 *  - overridePresence: staff-only (POST /v1/sessions/{id}/override).
 *  - requestPresenceCheck: student self-service, ONLY ever for the caller's
 *    own record — the backend derives identity from the verified session,
 *    never from a client-sent id (POST /v1/sessions/{id}/request-check).
 *  Both persist for real (migration 0012 adds via='override' for the audit
 *  trail). */

import { API_BASE, authHeader } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import type { AttendanceState } from "@/lib/data/types";

export { authHeader };

export async function overridePresence(
  sessionId: string,
  studentId: string,
  state: AttendanceState,
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ student_id: studentId, state }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Override failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
}

export async function requestPresenceCheck(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/request-check`, {
    method: "POST",
    headers: await authHeader(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
}
