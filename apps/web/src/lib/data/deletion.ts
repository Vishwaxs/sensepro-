/** Right-to-erasure requests go through the backend (service role), not a
 *  direct Supabase client write: deletion_requests has no client insert/
 *  update policy (migration 0013) — only the backend endpoints below, so an
 *  approval always runs the actual purge (embeddings + consent withdrawal,
 *  backend/app/admin_api.py) rather than just flipping a status column. */

import { API_BASE } from "@/lib/api";
import { authHeader } from "@/lib/data/attendance";

export interface MyDeletionRequest {
  id: string;
  status: "pending" | "approved" | "denied";
  requested_at: string;
  resolved_at: string | null;
}

export async function requestMyDeletion(): Promise<MyDeletionRequest> {
  const res = await fetch(`${API_BASE}/v1/students/me/deletion-request`, {
    method: "POST",
    headers: await authHeader(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Deletion request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

export async function fetchMyDeletionRequest(): Promise<MyDeletionRequest | null> {
  const res = await fetch(`${API_BASE}/v1/students/me/deletion-request`, {
    headers: await authHeader(),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.request ?? null;
}

export async function resolveDeletionRequest(requestId: string, approve: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/admin/deletion-requests/${requestId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ approve }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resolve failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
}
