/** Where the browser reaches the FastAPI backend for HTTP calls.
 *
 *  Default: hit the local backend directly — the classroom-laptop dev setup,
 *  where the capture page runs on http://localhost and CORS already allows it.
 *
 *  Phone demo behind ONE HTTPS tunnel: set VITE_API_BASE=/api so calls go
 *  same-origin through the Vite dev proxy (see vite.config.ts) — that keeps the
 *  phone on a single secure origin (getUserMedia needs HTTPS) with no
 *  mixed-content or CORS to fight. The capture WebSocket stays on VITE_WS_URL. */
export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

/** Origin the absentee QR sends a phone to.
 *
 *  Defaults to wherever the capture page is open. For the tunnel demo set
 *  VITE_CLAIM_BASE=https://<tunnel> so the QR resolves to a secure, phone-
 *  reachable origin even though the capture page itself stays on local http
 *  for its WebSocket (avoiding ws:// mixed-content on an https page). */
export function claimBase(): string {
  return (
    import.meta.env.VITE_CLAIM_BASE || (typeof window !== "undefined" ? window.location.origin : "")
  );
}

interface ClerkWindow {
  Clerk?: {
    loaded?: boolean;
    session?: {
      getToken: () => Promise<string | null>;
    };
  };
}

/** Resolves active auth token from Clerk session (or Supabase fallback). */
export async function getAuthToken(): Promise<string | null> {
  if (typeof window !== "undefined") {
    let clerk = (window as unknown as ClerkWindow).Clerk;
    if (!clerk?.loaded) {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 40));
        clerk = (window as unknown as ClerkWindow).Clerk;
        if (clerk?.loaded) break;
      }
    }
    if (clerk?.session) {
      try {
        const token = await clerk.session.getToken();
        if (token) return token;
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const { supabaseAuth } = await import("@/lib/supabase");
    const { data } = await supabaseAuth.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Resolves authorization headers with Bearer token. */
export async function authHeader(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
