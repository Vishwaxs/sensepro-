import { API_BASE, authHeader } from "@/lib/api";

export interface NotificationStatus {
  configured: boolean;
  provider: string;
  from_email: string;
  admin_notify_email: string;
}

export interface SessionSummaryPayload {
  session_id: string;
  class_section?: string;
  subject?: string;
  mode?: string;
  present_count: number;
  total_enrolled?: number;
  attended_count?: number;
  vnei_pct?: number | null;
  flags_count?: number;
  to_email?: string;
}

export async function fetchNotificationStatus(): Promise<NotificationStatus> {
  const res = await fetch(`${API_BASE}/v1/notifications/status`);
  if (!res.ok) {
    throw new Error(`Failed to fetch notification status: ${res.statusText}`);
  }
  return res.json();
}

export async function sendTestNotification(to_email?: string): Promise<{ success: boolean; id?: string }> {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeader()),
  };
  const res = await fetch(`${API_BASE}/v1/notifications/test`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_email: to_email || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Failed to send test email");
  }
  return res.json();
}

export async function sendSessionSummaryNotification(
  payload: SessionSummaryPayload,
): Promise<{ queued: boolean }> {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeader()),
  };
  const res = await fetch(`${API_BASE}/v1/notifications/session-summary`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Failed to send session summary email");
  }
  return res.json();
}
