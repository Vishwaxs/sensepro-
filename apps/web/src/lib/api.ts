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
      getToken: (options?: { skipCache?: boolean }) => Promise<string | null>;
    };
  };
}

export interface AuthTokenOptions {
  forceRefresh?: boolean;
}

/** Resolves active auth token from Clerk session (or Supabase fallback). */
export async function getAuthToken(options: AuthTokenOptions = {}): Promise<string | null> {
  if (typeof window !== "undefined") {
    let clerk = (window as unknown as ClerkWindow).Clerk;
    if (!clerk?.loaded) {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        clerk = (window as unknown as ClerkWindow).Clerk;
        if (clerk?.loaded) break;
      }
    }
    if (clerk?.session) {
      try {
        const token = await clerk.session.getToken(
          options.forceRefresh ? { skipCache: true } : undefined,
        );
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

export interface ApiReadyOptions {
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * Wait until the backend has completed startup before minting a short-lived
 * credential for a protected capture request. `/healthz` is public and only a
 * successful HTTP response is required here; its diagnostic payload is shown
 * separately by the application shell.
 */
export async function waitForApiReady(options: ApiReadyOptions = {}): Promise<void> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 90_000);
  const attemptTimeoutMs = Math.max(250, options.attemptTimeoutMs ?? 12_000);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const deadline = Date.now() + timeoutMs;
  let lastIssue = "the backend did not respond";

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs));
    try {
      const response = await fetch(`${API_BASE}/healthz`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) return;
      lastIssue = `readiness returned HTTP ${response.status}`;
    } catch (error) {
      lastIssue =
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "the readiness request timed out";
    } finally {
      clearTimeout(timer);
    }

    const pauseMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  throw new Error(
    `Backend did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds (${lastIssue}).`,
  );
}

/** Resolves authorization headers with Bearer token. */
export async function authHeader(options: AuthTokenOptions = {}): Promise<Record<string, string>> {
  const token = await getAuthToken(options);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
