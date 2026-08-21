import { API_BASE, authHeader } from "@/lib/api";
import type { RoleRequestRow } from "@/lib/data/types";

export interface SubmitRoleRequestPayload {
  email: string;
  fullName?: string;
  requestedRole: "teacher" | "management" | "admin" | "student";
  reason?: string;
  userId?: string;
}

export interface SubmitRoleRequestResponse {
  success: boolean;
  request: RoleRequestRow;
  pending_count: number;
  notification?: {
    success: boolean;
    rate_limited?: boolean;
    cooldown_remaining_s?: number;
    pending_count?: number;
  };
}

export async function submitRoleRequest(
  payload: SubmitRoleRequestPayload,
): Promise<SubmitRoleRequestResponse> {
  const base = API_BASE;
  const res = await fetch(`${base}/v1/admin/role-requests/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: payload.email,
      full_name: payload.fullName,
      requested_role: payload.requestedRole,
      reason: payload.reason,
      user_id: payload.userId,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Submit failed (${res.status})`);
  }
  return res.json();
}

export async function fetchMyRoleRequestStatus(
  email?: string,
  userId?: string,
): Promise<RoleRequestRow | null> {
  const base = API_BASE;
  const params = new URLSearchParams();
  if (email) params.set("email", email);
  if (userId) params.set("user_id", userId);

  const res = await fetch(`${base}/v1/admin/role-requests/my-status?${params.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.request ?? null;
}

export async function fetchAdminRoleRequests(
  status?: string,
): Promise<{ items: RoleRequestRow[]; pending_count: number }> {
  const base = API_BASE;
  const headers = await authHeader();
  const url = status
    ? `${base}/v1/admin/role-requests?status=${encodeURIComponent(status)}`
    : `${base}/v1/admin/role-requests`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Fetch role requests failed (${res.status})`);
  }
  return res.json();
}

export async function resolveAdminRoleRequest(
  requestId: string,
  approve: boolean,
  role?: string,
): Promise<RoleRequestRow> {
  const base = API_BASE;
  const headers = await authHeader();
  const res = await fetch(`${base}/v1/admin/role-requests/${requestId}/resolve`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      approve,
      role,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Resolve failed (${res.status})`);
  }
  const data = await res.json();
  return data.request;
}

export async function sendAdminRoleDigest(): Promise<{ success: boolean; pending_count: number }> {
  const base = API_BASE;
  const headers = await authHeader();
  const res = await fetch(`${base}/v1/admin/role-requests/send-digest`, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Send digest failed (${res.status})`);
  }
  return res.json();
}
