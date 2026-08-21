import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { guardRoute } from "@/lib/auth-guard";
import { supabase, supabaseAuth } from "@/lib/supabase/client";
import { API_BASE } from "@/lib/api";

export const Route = createFileRoute("/claim")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === "string" ? s.token : "",
  }),
  beforeLoad: guardRoute(["student"]),
  head: () => ({
    meta: [{ title: "Verify attendance · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: ClaimPage,
});

type Phase = "claiming" | "verifying" | "verified" | "expired" | "error";

function ClaimPage() {
  const { token } = Route.useSearch();
  const [phase, setPhase] = useState<Phase>("claiming");
  const [message, setMessage] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null); // retryable "didn't match" hint
  const [cameraError, setCameraError] = useState<string | null>(null);
  const windowIdRef = useRef<string | null>(null);
  const deadlineRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Claim the token on mount (opens a verification window; marks nothing).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setPhase("error");
        setMessage("No code in the link — scan the QR again.");
        return;
      }
      try {
        const {
          data: { session },
        } = await supabaseAuth.auth.getSession();
        if (!session) throw new Error("Please sign in first, then rescan.");
        const resp = await fetch(`${API_BASE}/v1/qr/claim`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ token }),
        });
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
        if (cancelled) return;
        windowIdRef.current = body.window_id;
        deadlineRef.current = Date.now() + body.seconds * 1000;
        setRemaining(body.seconds);
        setMessage(body.message);
        setPhase("verifying");
      } catch (err) {
        if (cancelled) return;
        setPhase("error");
        setMessage(err instanceof Error ? err.message : "Could not verify.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // While verifying: count down, and (bonus) listen for the classroom camera
  // satisfying the window server-side. The selfie POST is the primary signal.
  useEffect(() => {
    if (phase !== "verifying") return;
    const wid = windowIdRef.current;

    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        setPhase("expired");
        setMessage("Not verified in time — ask for a new code.");
      }
    }, 500);

    const channel = supabase
      .channel(`vwin-${wid}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "verification_windows",
          filter: `id=eq.${wid}`,
        },
        (payload) => {
          const row = payload.new as { satisfied_at: string | null };
          if (row?.satisfied_at) setPhase("verified");
        },
      )
      .subscribe();

    return () => {
      window.clearInterval(tick);
      void supabase.removeChannel(channel);
    };
  }, [phase]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Front camera lives only for the verifying phase.
  useEffect(() => {
    if (phase !== "verifying") return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            /* autoplay policy — the muted inline video plays on its own */
          });
        }
      } catch {
        if (!cancelled)
          setCameraError("Camera blocked. Allow camera access in your browser, then retry.");
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [phase, stopCamera]);

  const captureAndVerify = useCallback(async () => {
    const video = videoRef.current;
    const wid = windowIdRef.current;
    // A silent `return` here was a real failure mode: on a slower phone the
    // stream has no dimensions for the first moment after permission is
    // granted, so tapping "Verify me" did precisely nothing — no spinner, no
    // message — while the student's 30-second window ran out and they tapped
    // again and again. Say what is happening instead.
    if (!video || !video.videoWidth) {
      setNote("Camera is still starting — try again in a second.");
      return;
    }
    if (!wid) {
      setNote("No open verification window — rescan the code.");
      return;
    }
    setSubmitting(true);
    setNote(null);
    try {
      // Downscale to keep the upload tiny on weak phone internet (~40 KB).
      const maxW = 480;
      const scale = Math.min(1, maxW / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.7));
      if (!blob) throw new Error("Could not capture the photo — try again.");

      const {
        data: { session },
      } = await supabaseAuth.auth.getSession();
      if (!session) throw new Error("Session expired — sign in and rescan.");

      const form = new FormData();
      form.append("window_id", wid);
      form.append("selfie", blob, "selfie.jpg");
      const resp = await fetch(`${API_BASE}/v1/qr/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      const body = await resp.json().catch(() => ({ detail: resp.statusText }));

      if (resp.ok && body.verified) {
        stopCamera();
        setPhase("verified");
      } else if (resp.ok) {
        setNote(body.reason || "Face didn't match — try again in better light.");
      } else if (resp.status === 410) {
        setPhase("expired");
        setMessage(body.detail || "This window expired — ask for a new code.");
      } else if (resp.status === 403 || resp.status === 404) {
        setPhase("error");
        setMessage(body.detail || "Could not verify.");
      } else {
        setNote(body.detail || `Couldn't verify (HTTP ${resp.status}).`);
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not verify — try again.");
    } finally {
      setSubmitting(false);
    }
  }, [stopCamera]);

  return (
    <div className="grid min-h-dvh place-items-center bg-[color:var(--bg)] p-6">
      <div className="glass-panel w-full max-w-sm p-7 text-center">
        {phase === "claiming" && (
          <Stage icon={<Loader2 className="h-8 w-8 animate-spin text-[color:var(--primary)]" />}>
            <Title>Claiming code…</Title>
          </Stage>
        )}

        {phase === "verifying" && (
          <div>
            <Title>Verify it&apos;s you</Title>
            <p className="mt-2 text-sm text-[color:var(--muted)]">{message}</p>

            <div className="mt-4 overflow-hidden rounded-xl border border-[color:var(--line)] bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className="mx-auto aspect-[3/4] w-52 object-cover [transform:scaleX(-1)]"
              />
            </div>

            <div className="mt-3 inline-flex items-center gap-1.5 font-mono-nums text-lg font-extrabold text-[color:var(--ink)]">
              <Clock className="h-4 w-4 text-[color:var(--muted)]" />
              {remaining}s
            </div>

            {cameraError ? (
              <p className="mt-3 text-sm text-[color:var(--bad)]">{cameraError}</p>
            ) : (
              <button
                onClick={() => void captureAndVerify()}
                disabled={submitting}
                className="sp-btn sp-btn-primary mt-3 w-full justify-center disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                  </>
                ) : (
                  <>
                    <Camera className="h-4 w-4" /> Verify me
                  </>
                )}
              </button>
            )}

            {note && <p className="mt-3 text-sm text-[color:var(--warn)]">{note}</p>}
          </div>
        )}

        {phase === "verified" && (
          <Stage
            icon={<CheckCircle2 className="h-8 w-8 text-[color:var(--ok)]" />}
            tone="border-[color:var(--ok)]/40 bg-[color:var(--ok)]/8"
          >
            <Title>You&apos;re marked present</Title>
            <p className="mt-2 text-sm text-[color:var(--muted)]">
              Your face was verified in the room. Attendance recorded.
            </p>
          </Stage>
        )}

        {phase === "expired" && (
          <Stage
            icon={<XCircle className="h-8 w-8 text-[color:var(--warn)]" />}
            tone="border-[color:var(--warn)]/40 bg-[color:var(--warn)]/8"
          >
            <Title>Not verified</Title>
            <p className="mt-2 text-sm text-[color:var(--muted)]">{message}</p>
          </Stage>
        )}

        {phase === "error" && (
          <Stage
            icon={<XCircle className="h-8 w-8 text-[color:var(--bad)]" />}
            tone="border-[color:var(--bad)]/40 bg-[color:var(--bad)]/8"
          >
            <Title>Couldn&apos;t verify</Title>
            <p className="mt-2 text-sm text-[color:var(--muted)]">{message}</p>
          </Stage>
        )}
      </div>
    </div>
  );
}

function Stage({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className={`mx-auto grid h-16 w-16 place-items-center rounded-full border ${
          tone ?? "border-[color:var(--line)] bg-[color:var(--surface-2)]/40"
        }`}
      >
        {icon}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
      {children}
    </h1>
  );
}
