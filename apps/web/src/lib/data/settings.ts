/** Global feature toggles (migration 0014) — read/write through the backend
 *  (service role): app_settings has no client write policy, and the write
 *  endpoint appends an audit_log entry a direct client write couldn't. */

import { API_BASE } from "@/lib/api";
import { authHeader } from "@/lib/data/attendance";

export async function fetchSetting(key: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/v1/settings/${key}`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`Could not load setting '${key}' (${res.status})`);
  const body = await res.json();
  return Boolean(body.value);
}

export async function updateSetting(key: string, value: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/settings/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Update failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
}
