import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Users, Video } from "lucide-react";
import type { PresenceState, ResultMessage, ServerMessage } from "@/lib/types";
import { fmtClock } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LiveDot } from "@/components/LiveDot";
import { CountUp } from "@/components/CountUp";
import { StateBadge } from "@/components/StateBadge";

/** Live capture kiosk. Speaks the exact WebSocket contract of
 *  backend/app/ws.py:
 *    client -> server  {type:"frame", ts, jpg_b64}   at 1/fps
 *                      {type:"end", ts}
 *    server -> client  {type:"result", ts, faces[], transitions[], present[]}
 *                      {type:"error", detail} | {type:"session_ended", ts}
 *  Boxes arrive in SENT-frame pixels and are scaled to the displayed video.
 *  The live view stays lean by design: the camera feed is the spectacle. */

const DEFAULT_WS = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8000/ws/capture";

type Status = "idle" | "connecting" | "live" | "ended" | "error";

interface TransitionEvent {
  at: number;
  student_id: string;
  state: PresenceState;
}

const STATUS_LINE: Record<Status, string> = {
  idle: "ready — configure and start the session",
  connecting: "connecting to inference backend…",
  live: "streaming frames · results overlaying live",
  ended: "session ended — presence intervals closed",
  error: "connection failed — is the backend running?",
};

export function CaptureKiosk() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const t0Ref = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS);
  const [fps, setFps] = useState(2);
  const [sendWidth, setSendWidth] = useState(480);
  const [className, setClassName] = useState("MCA-3A · Distributed Systems");
  const [elapsed, setElapsed] = useState(0);
  const [present, setPresent] = useState<string[]>([]);
  const [events, setEvents] = useState<TransitionEvent[]>([]);

  const live = status === "live";

  const drawBoxes = useCallback((msg: ResultMessage) => {
    const overlay = overlayRef.current;
    const cap = captureRef.current;
    if (!overlay || !cap) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const sx = overlay.width / cap.width;
    const sy = overlay.height / cap.height;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.lineWidth = 2;
    ctx.font = "14px 'IBM Plex Mono', ui-monospace, monospace";
    for (const f of msg.faces) {
      const [x1, y1, x2, y2] = f.box;
      const named = f.student_id !== null;
      const color = named ? "#34D399" : "#FBBF24";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
      const label = named ? `${f.student_id} ${f.score.toFixed(2)}` : `#${f.track_id}`;
      ctx.fillText(label, x1 * sx, Math.max(14, y1 * sy - 6));
    }
  }, []);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      if (msg.type === "result") {
        sendingRef.current = false;
        drawBoxes(msg);
        setPresent(msg.present);
        if (msg.transitions.length) {
          setEvents((prev) =>
            [...msg.transitions.map((t) => ({ at: msg.ts, ...t })), ...prev].slice(0, 8),
          );
        }
      } else if (msg.type === "error") {
        sendingRef.current = false;
      } else if (msg.type === "session_ended") {
        setStatus("ended");
      }
    },
    [drawBoxes],
  );

  const stopTimers = useCallback(() => {
    if (sendTimerRef.current !== null) window.clearInterval(sendTimerRef.current);
    if (clockTimerRef.current !== null) window.clearInterval(clockTimerRef.current);
    sendTimerRef.current = null;
    clockTimerRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setStatus("connecting");
    setEvents([]);
    setPresent([]);
    stopStream(); // never leave a prior camera track running on restart
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      /* play() resolving does not guarantee dimensions — wait for metadata,
         otherwise videoWidth/Height can be 0 and every canvas sizes to NaN. */
      if (!video.videoWidth || !video.videoHeight) {
        await new Promise<void>((res) => {
          video.addEventListener("loadedmetadata", () => res(), { once: true });
        });
      }
      if (!video.videoWidth || !video.videoHeight) {
        stopStream();
        setStatus("error");
        return;
      }

      /* Camera labels only populate after permission is granted. */
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));

      const cap = document.createElement("canvas");
      const ar = video.videoHeight / video.videoWidth;
      cap.width = sendWidth;
      cap.height = Math.round(sendWidth * ar);
      captureRef.current = cap;

      const overlay = overlayRef.current!;
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      t0Ref.current = Date.now();
      sendingRef.current = false;

      ws.onopen = () => {
        setStatus("live");
        setElapsed(0);
        clockTimerRef.current = window.setInterval(
          () => setElapsed((Date.now() - t0Ref.current) / 1000),
          1000,
        );
        const cctx = cap.getContext("2d")!;
        sendTimerRef.current = window.setInterval(
          () => {
            if (ws.readyState !== WebSocket.OPEN || sendingRef.current) return;
            cctx.drawImage(video, 0, 0, cap.width, cap.height);
            const jpg_b64 = cap.toDataURL("image/jpeg", 0.6).split(",")[1];
            sendingRef.current = true;
            ws.send(
              JSON.stringify({ type: "frame", ts: (Date.now() - t0Ref.current) / 1000, jpg_b64 }),
            );
          },
          1000 / Math.max(0.5, fps),
        );
      };
      ws.onmessage = (e) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data) as ServerMessage;
        } catch {
          sendingRef.current = false; // don't let a bad frame freeze sending
          return;
        }
        handleMessage(msg);
      };
      ws.onerror = () => {
        stopStream(); // the error state offers no End button — release the camera here
        setStatus("error");
      };
      ws.onclose = () => {
        stopTimers();
        setStatus((s) => {
          if (s === "live" || s === "connecting") {
            stopStream();
            return "error";
          }
          return s;
        });
      };
    } catch {
      stopStream();
      setStatus("error");
    }
  }, [deviceId, fps, handleMessage, sendWidth, stopStream, stopTimers, wsUrl]);

  const end = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end", ts: (Date.now() - t0Ref.current) / 1000 }));
    }
    stopTimers();
    stopStream();
    setStatus("ended");
  }, [stopStream, stopTimers]);

  /* Full teardown on unmount */
  useEffect(() => {
    return () => {
      stopTimers();
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopTimers]);

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <h1 className="sr-only">Live capture kiosk</h1>
      {/* Slim top bar */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface/80 px-4 py-2.5 backdrop-blur-md">
        <Link
          to="/teacher"
          className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Console
        </Link>
        <span className="hidden h-4 w-px bg-line sm:block" aria-hidden="true" />
        <input
          aria-label="Class name"
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          className="min-w-0 flex-1 basis-40 border-none bg-transparent font-display text-[15px] font-700 text-ink"
        />
        <div className="ml-auto flex items-center gap-4 font-mono text-[12.5px]">
          {live && (
            <span className="flex items-center gap-2 text-accent">
              <LiveDot /> LIVE
            </span>
          )}
          <span className="tabular-nums text-muted" aria-label="Session timer">
            {fmtClock(elapsed)}
          </span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 lg:flex-row">
        {/* Stage */}
        <div className="relative min-w-0 flex-1">
          <div className="relative overflow-hidden rounded-panel border border-line bg-black">
            <video ref={videoRef} autoPlay playsInline muted className="block w-full" />
            <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            {status === "idle" && (
              <div className="absolute inset-0 grid place-items-center bg-bg/60">
                <div className="text-center">
                  <Video className="mx-auto size-8 text-muted" aria-hidden="true" />
                  <p className="mt-2 font-mono text-[12.5px] text-muted">camera off</p>
                </div>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!live && status !== "connecting" ? (
              <Button onClick={start}>Start camera + session</Button>
            ) : (
              <Button variant="danger" onClick={end} disabled={!live}>
                End session
              </Button>
            )}
            <p className="font-mono text-[12px] text-muted" role="status">
              {STATUS_LINE[status]}
            </p>
          </div>

          {/* Config row */}
          <details className="mt-3 rounded-lg border border-line bg-surface/60 px-4 py-2.5 text-[13px] open:pb-4">
            <summary className="cursor-pointer font-mono text-[11.5px] tracking-wider text-muted uppercase select-none">
              Capture settings
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-muted">
                <span className="text-xs">Camera</span>
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={live}
                  className="min-h-10 rounded-lg border border-line bg-surface-2 px-2 text-[13px] text-ink"
                >
                  <option value="">Default camera</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-muted">
                <span className="text-xs">Server (WebSocket)</span>
                <input
                  value={wsUrl}
                  onChange={(e) => setWsUrl(e.target.value)}
                  disabled={live}
                  className="min-h-10 rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-muted">
                <span className="text-xs">Frames / second</span>
                <input
                  type="number"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) || 2)}
                  disabled={live}
                  className="min-h-10 rounded-lg border border-line bg-surface-2 px-2 font-mono text-[13px] text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-muted">
                <span className="text-xs">Send width (px)</span>
                <input
                  type="number"
                  min={240}
                  max={1280}
                  step={80}
                  value={sendWidth}
                  onChange={(e) => setSendWidth(Number(e.target.value) || 480)}
                  disabled={live}
                  className="min-h-10 rounded-lg border border-line bg-surface-2 px-2 font-mono text-[13px] text-ink"
                />
              </label>
            </div>
          </details>

          <p className="mt-3 text-[12px] leading-relaxed text-muted/80">
            Frames are downscaled in the browser and sent to the inference backend, processed in
            memory and never stored. Recognition is embeddings-only. This screen is the on-camera
            processing disclosure for everyone in the room.
          </p>
        </div>

        {/* Present-now rail */}
        <aside className="w-full shrink-0 lg:w-72">
          <div className="panel flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
                {live && <LiveDot />}
                Present now
              </h2>
              <span className="flex items-center gap-1.5 font-display text-lg font-800 text-ink">
                <Users className="size-4 text-muted" aria-hidden="true" />
                <CountUp value={present.length} />
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {present.length === 0 ? (
                <p className="px-1 py-6 text-center font-mono text-[12px] text-muted">
                  — no one recognised yet —
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {present.map((id) => (
                    <li
                      key={id}
                      className="flex items-center gap-2.5 rounded-lg border border-ok/25 bg-ok/10 px-3 py-2 font-mono text-[13px] text-ok"
                    >
                      <LiveDot tone="ok" />
                      {id}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {events.length > 0 && (
              <div className="border-t border-line p-3">
                <h3 className="mb-2 px-1 font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">
                  Recent transitions
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {events.map((ev, i) => (
                    <li
                      key={`${ev.student_id}-${ev.at}-${i}`}
                      className="flex items-center justify-between gap-2 px-1 text-[12px]"
                    >
                      <span className="truncate font-mono text-muted">{ev.student_id}</span>
                      <StateBadge state={ev.state} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
