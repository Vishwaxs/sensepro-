import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Loader2, QrCode, RefreshCw, X } from "lucide-react";
import { API_BASE, authHeader, claimBase } from "@/lib/api";
import { supabase } from "@/lib/supabase/client";

/**
 * Teacher-side absentee verification window. Mints a rotating, single-use token
 * from the backend and renders it as a QR the student scans from their phone.
 * The QR NEVER marks attendance — it opens a short face-verification window; the
 * camera does the marking. Rotates automatically before each token expires.
 */
export function AbsenteeQR({
  sessionId,
  apiBase = API_BASE,
  onClose,
  onVerified,
}: {
  sessionId: string;
  apiBase?: string;
  onClose?: () => void;
  onVerified?: (studentId: string) => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number>(0); // epoch ms
  const [remaining, setRemaining] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetching = useRef(false);
  // Backoff state for failed mints. Without it, a failure leaves `deadline` at
  // 0, so the rotate check below (`left <= 8`) is true on every tick and the
  // panel hammers /v1/qr/token once a second for as long as the teacher leaves
  // the screen open — during a class, against a backend that is also running
  // the capture pipeline.
  const failures = useRef(0);
  const retryAfter = useRef(0);

  const fetchToken = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setError(null);
    try {
      const headers = await authHeader();
      const resp = await fetch(`${apiBase}/v1/qr/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const body = await resp.json().catch(() => ({ detail: resp.statusText }));
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      setToken(body.token);
      setDeadline(Date.now() + body.ttl_s * 1000);
      failures.current = 0;
      retryAfter.current = 0;
    } catch (err) {
      failures.current += 1;
      // 2s, 4s, 8s … capped at 30s.
      const waitMs = Math.min(30_000, 2000 * 2 ** (failures.current - 1));
      retryAfter.current = Date.now() + waitMs;
      setError(err instanceof Error ? err.message : "Could not open the window");
    } finally {
      setLoading(false);
      fetching.current = false;
    }
  }, [apiBase, sessionId]);

  // Initial mint.
  useEffect(() => {
    void fetchToken();
  }, [fetchToken]);

  // 1s countdown + auto-rotate a few seconds before expiry.
  // With a 20s claim TTL, pre-rotating at 3s gives the QR 17s of visibility —
  // comfortable for scanning — while leaving enough overlap for the mint
  // round-trip. The old 8s overlap was designed for a 75s TTL.
  useEffect(() => {
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (Date.now() < retryAfter.current) return; // backing off after a failure
      // deadline === 0 means "no token yet" (first mint failed). Retry on the
      // backoff schedule rather than every second.
      if (deadline === 0 || left <= 3) void fetchToken();
    }, 1000);
    return () => window.clearInterval(id);
  }, [deadline, fetchToken]);

  const close = useCallback(async () => {
    try {
      const headers = await authHeader();
      await fetch(`${apiBase}/v1/qr/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      /* best-effort; closing the panel is what matters to the operator */
    } finally {
      onClose?.();
    }
  }, [apiBase, sessionId, onClose]);

  // Live feed of verified students — Realtime subscription on
  // verification_windows. When a window is satisfied, the student's name
  // appears on the teacher's screen so they can confirm the person is present.
  const [verified, setVerified] = useState<{ name: string; at: number }[]>([]);
  useEffect(() => {
    const channel = supabase
      .channel(`qr-verified-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "verification_windows",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as {
            satisfied_at: string | null;
            student_id: string;
          };
          if (!row?.satisfied_at) return;
          onVerified?.(row.student_id);
          // Fetch the student name from the students table.
          void (async () => {
            try {
              const { data } = await supabase
                .from("students")
                .select("full_name,reg_no")
                .eq("id", row.student_id)
                .limit(1)
                .single();
              const label = data?.full_name || data?.reg_no || row.student_id.slice(0, 8);
              setVerified((prev) => [
                { name: label, at: Date.now() },
                ...prev.slice(0, 19),
              ]);
            } catch {
              setVerified((prev) => [
                { name: row.student_id.slice(0, 8), at: Date.now() },
                ...prev.slice(0, 19),
              ]);
            }
          })();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionId]);

  const claimUrl = token ? `${claimBase()}/claim?token=${token}` : "";

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
          <QrCode className="h-3.5 w-3.5" /> Absentee verification
        </div>
        <button
          onClick={() => void close()}
          className="p-1 text-[color:var(--muted)] hover:text-[color:var(--ink)]"
          aria-label="Close window"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 grid place-items-center">
        {loading && !token ? (
          <div className="grid h-[220px] w-[220px] place-items-center text-[color:var(--muted)]">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="grid h-[220px] w-[220px] place-items-center gap-2 rounded-md border border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 p-4 text-center text-xs text-[color:var(--bad)]">
            <span>{error}</span>
            <button onClick={() => void fetchToken()} className="sp-btn sp-btn-secondary">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : (
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG
              value={claimUrl}
              size={200}
              level="M"
              includeMargin={false}
              fgColor="#000000"
              bgColor="#ffffff"
            />
          </div>
        )}
      </div>

      <div className="mt-3 text-center">
        <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
          Rotates in <span className="text-[color:var(--ink)]">{remaining}s</span> · single-use
        </div>
        <p className="mt-2 text-xs text-[color:var(--muted)]">
          An absent student scans this from their signed-in app, then verifies with a quick selfie.
          The QR only grants a short window — presence is still marked by matching the enrolled
          face.
        </p>
      </div>

      {verified.length > 0 && (
        <div className="mt-4 border-t border-[color:var(--line)] pt-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-[color:var(--ok)]">
            <CheckCircle2 className="h-3 w-3" /> Verified ({verified.length})
          </div>
          <ul className="mt-2 space-y-1">
            {verified.map((v, i) => (
              <li
                key={`${v.name}-${v.at}-${i}`}
                className="text-xs text-[color:var(--ink)] animate-in fade-in slide-in-from-top-1 duration-300"
              >
                {v.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
