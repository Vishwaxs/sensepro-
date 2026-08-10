import { createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Maximize2,
  Minimize2,
  Play,
  QrCode,
  Square as StopIcon,
  Settings2,
  X,
  Video,
} from "lucide-react";
import { AbsenteeQR } from "@/components/sp/AbsenteeQR";
import { ConnectionBadge, type ConnState } from "@/components/sp/ConnectionBadge";
import { cn } from "@/lib/utils";
import { guardRoute } from "@/lib/auth-guard";
import { API_BASE } from "@/lib/api";

// Sentinel device ID for the backend-side RTSP camera source.
const RTSP_SOURCE = "__rtsp__";
const RTSP_LABEL = "CP Plus RTSP · 10.101.40.189";

// The class this capture station records for. class_section MUST match the
// students' class_section in Supabase — the QR claim rejects any student whose
// class differs (403). Override per deployment via env.
const CLASS_SECTION = import.meta.env.VITE_CLASS_SECTION || "MCA-4B";
const CLASS_SUBJECT = import.meta.env.VITE_CLASS_SUBJECT || "Distributed Systems";

export const Route = createFileRoute("/capture")({
  beforeLoad: guardRoute(["teacher", "admin"]),
  head: () => ({
    meta: [{ title: "Capture · SensePro+" }],
  }),
  component: CapturePage,
});

// ---- Types matching the frozen WS contract ----
interface WsFace {
  box: [number, number, number, number];
  student_id: string | null;
  score: number;
  track_id: number;
}
interface WsPresentRow {
  student_id: string;
  name: string;
  reg_no: string;
  first_seen_ts: number;
}
interface WsTransition {
  // The pipeline emits the lean {student_id, state} shape; kind/name are only
  // present if a future server enriches transitions. Both are tolerated below.
  kind?: "enter" | "leave" | "recognised";
  state?: "PRESENT" | "ABSENT";
  student_id?: string;
  name?: string;
  reg_no?: string;
  track_id?: number;
  ts?: number;
}
interface WsResult {
  type: "result";
  ts: number;
  faces: WsFace[];
  // The backend sends `present` as bare id strings; the demo seed (and any
  // future richer server) sends full rows. handleWsMessage normalises both.
  present: (WsPresentRow | string)[];
  transitions: WsTransition[];
  // Cumulative attendance: student_ids that have been seen >= threshold times
  // this session. Once attended, never flips back.
  attended?: string[];
  // Optional: the current pipeline omits it — startSending tracks sent size locally.
  sent_size?: { w: number; h: number };
}

/** Build the capture WebSocket URL — ALWAYS same-origin, through the Vite `/api`
 *  proxy (which forwards WS upgrades to the backend). The socket therefore
 *  matches the page's own protocol + host: an https page (tunnel) gets `wss`
 *  (so the browser's mixed-content rule can never block it), an http page gets
 *  `ws`, and localhost / 127.0.0.1 / a tunnel hostname all resolve to whatever
 *  actually served the page. An absolute `ws(s)://host` in VITE_WS_URL is
 *  deliberately ignored — that is exactly what reintroduces mixed-content and
 *  IPv6 failures; only a relative "/path" override is honoured. */
function resolveWsUrl(): string {
  const raw = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  const path = raw && raw.startsWith("/") ? raw : "/api/ws/capture";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

function CapturePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const startEpochRef = useRef<number>(0);
  // Active class-session id, held in a ref so openSocket (and its reconnects)
  // can attach the WS pipeline to a real session for presence + QR fallback.
  const sessionIdRef = useRef<string | null>(null);
  // Per-track visualisation state for smooth lerp between results.
  interface TrackVis {
    prev: [number, number, number, number];
    target: [number, number, number, number];
    targetTs: number;
    appearTs: number;
    labelAppearTs: number;
    student_id: string | null;
    score: number;
    track_id: number;
    lastSeenTs: number;
  }
  const tracksRef = useRef<Map<number, TrackVis>>(new Map());
  const sentRef = useRef<{ w: number; h: number }>({ w: 1280, h: 720 });
  const lastResultAtRef = useRef<number>(0);
  // reg_no|id -> display name/reg_no, loaded once from the students table so the
  // overlay label and PRESENT panel can show names for the bare ids the WS emits.
  const nameMapRef = useRef<Map<string, { name: string; reg_no: string }>>(new Map());
  // Stable first-seen wall-clock (seconds) per present id — the lean WS `present`
  // is ids only, so we time first appearance here rather than trust the server.
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  // Mirrors `running` for the WS onclose reconnect check. start() opens the
  // socket from the render where running was still false, so a plain closure
  // would capture running=false and never auto-reconnect after a drop. The ref
  // always holds the current value.
  const runningRef = useRef(false);
  // Frames sent but not yet answered. Caps how far the client outruns the
  // CPU-bound backend, so latency stays bounded (~1-2 frames) instead of the
  // overlay lagging further behind every second as a backlog builds.
  const inflightRef = useRef(0);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [sendWidth, setSendWidth] = useState(1280);
  const [fps, setFps] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [conn, setConn] = useState<ConnState>("OFFLINE");
  const [stale, setStale] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const [present, setPresent] = useState<WsPresentRow[]>([]);
  const [toasts, setToasts] = useState<{ id: string; text: string; kind: WsTransition["kind"] }[]>(
    [],
  );
  const [elapsed, setElapsed] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [rtspSessionId, setRtspSessionId] = useState<string | null>(null);
  const [absenteeOpen, setAbsenteeOpen] = useState(false);
  // Cumulative attendance: set of student_ids that have crossed the sighting
  // threshold this session. Updated from the WS `attended` field; displayed
  // alongside live presence in the roster panel.
  const [attended, setAttended] = useState<Set<string>>(new Set());

  const isRtsp = deviceId === RTSP_SOURCE;
  const [rosterHint, setRosterHint] = useState({ enrolled: 53 });
  // Same-origin WS URL through the /api proxy (see resolveWsUrl). Computed once;
  // "" during SSR (no window) — the socket only ever opens client-side.
  const wsUrl = useMemo(() => (typeof window === "undefined" ? "" : resolveWsUrl()), []);

  // Demo helper: ?demo=stale seeds a frozen roster + reconnecting state so the
  // stale-roster watermark can be reviewed without a real inference server.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("demo") !== "stale") return;
    setRunning(true);
    setConn("RECONNECTING");
    setStale(true);
    lastResultAtRef.current = performance.now() - 8_000;
    startEpochRef.current = Date.now() - 214_000;
    setPresent([
      {
        student_id: "23MCA1042",
        name: "Aarav Sharma",
        reg_no: "23MCA1042",
        first_seen_ts: Date.now() / 1000 - 180,
      },
      {
        student_id: "23MCA1043",
        name: "Diya Patel",
        reg_no: "23MCA1043",
        first_seen_ts: Date.now() / 1000 - 160,
      },
      {
        student_id: "23MCA1044",
        name: "Ishaan Nair",
        reg_no: "23MCA1044",
        first_seen_ts: Date.now() / 1000 - 120,
      },
      {
        student_id: "23MCA1045",
        name: "Ananya Reddy",
        reg_no: "23MCA1045",
        first_seen_ts: Date.now() / 1000 - 90,
      },
      {
        student_id: "23MCA1046",
        name: "Vihaan Iyer",
        reg_no: "23MCA1046",
        first_seen_ts: Date.now() / 1000 - 40,
      },
    ]);
  }, []);

  // Enumerate cameras
  useEffect(() => {
    (async () => {
      try {
        const list = await navigator.mediaDevices?.enumerateDevices?.();
        if (list) {
          const cams = list.filter((d) => d.kind === "videoinput");
          setCameras(cams);
          if (!deviceId && cams[0]) setDeviceId(cams[0].deviceId);
        }
      } catch {
        /* device enumeration unsupported/blocked */
      }
    })();
  }, [deviceId]);

  // Load the class roster once, from the backend /v1/roster endpoint (NOT a
  // direct browser `students` read — that is RLS-gated on app_role, which the
  // kiosk session may not carry, and would come back empty so the overlay shows
  // raw UUIDs). The backend reads it with the service key. This resolves the
  // student ids the WS returns to names + reg_nos, and sets the "present / N"
  // denominator to the real class headcount. Keyed by both id and reg_no so it
  // works regardless of which the embeddings use. Failure falls back to the raw id.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/roster?class_section=${encodeURIComponent(CLASS_SECTION)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          students?: { id: string; reg_no: string; full_name: string }[];
          count?: number;
        };
        if (!alive || !Array.isArray(data.students)) return;
        const m = new Map<string, { name: string; reg_no: string }>();
        for (const s of data.students) {
          const entry = { name: s.full_name, reg_no: s.reg_no };
          m.set(s.reg_no, entry);
          m.set(s.id, entry);
        }
        nameMapRef.current = m;
        if (typeof data.count === "number" && data.count > 0) {
          setRosterHint({ enrolled: data.count });
        }
      } catch {
        /* roster unreachable — overlay + panel fall back to showing the raw id */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Keep runningRef current for the WS reconnect decision (see openSocket).
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // Timer tick
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startEpochRef.current) / 1000)),
      500,
    );
    return () => clearInterval(t);
  }, [running]);

  // Overlay resize + redraw
  useEffect(() => {
    const draw = () => {
      const overlay = overlayRef.current;
      const video = videoRef.current;
      if (!overlay || !video) return;
      const rect = video.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w === 0 || h === 0) return;
      if (overlay.width !== w) overlay.width = w;
      if (overlay.height !== h) overlay.height = h;
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const tracks = tracksRef.current;
      if (tracks.size === 0) return;
      const sx = w / sentRef.current.w;
      const sy = h / sentRef.current.h;
      const now = performance.now();
      ctx.lineWidth = 2;
      ctx.font = '500 12px "IBM Plex Mono", monospace';
      const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
      for (const v of tracks.values()) {
        // Drop stale tracks (no update in ~1s)
        if (now - v.targetTs > 1000) continue;
        // Lerp prev -> target over 120ms
        const kt = Math.min(1, (now - v.targetTs) / 120);
        const k = easeOut(kt);
        const bx0 = v.prev[0] + (v.target[0] - v.prev[0]) * k;
        const by0 = v.prev[1] + (v.target[1] - v.prev[1]) * k;
        const bx1 = v.prev[2] + (v.target[2] - v.prev[2]) * k;
        const by1 = v.prev[3] + (v.target[3] - v.prev[3]) * k;
        const rx = bx0 * sx;
        const ry = by0 * sy;
        const rw = (bx1 - bx0) * sx;
        const rh = (by1 - by0) * sy;

        const known = !!v.student_id;
        // Cobalt -> green fade for recognised tracks (first 400ms after recognition)
        const rec = Math.min(1, (now - v.labelAppearTs) / 400);
        const boxAlpha = Math.min(1, (now - v.appearTs) / 180);
        let color: string;
        if (known) {
          // interp from cobalt(59,130,246) -> green(52,211,153)
          const r0 = 59 + (52 - 59) * rec;
          const g0 = 130 + (211 - 130) * rec;
          const b0 = 246 + (153 - 246) * rec;
          color = `rgba(${r0.toFixed(0)},${g0.toFixed(0)},${b0.toFixed(0)},${(0.95 * boxAlpha).toFixed(3)})`;
        } else {
          color = `rgba(251,191,36,${(0.95 * boxAlpha).toFixed(3)})`;
        }
        ctx.strokeStyle = color;
        // rounded rect
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(rx + r, ry);
        ctx.lineTo(rx + rw - r, ry);
        ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
        ctx.lineTo(rx + rw, ry + rh - r);
        ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
        ctx.lineTo(rx + r, ry + rh);
        ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
        ctx.lineTo(rx, ry + r);
        ctx.quadraticCurveTo(rx, ry, rx + r, ry);
        ctx.closePath();
        ctx.stroke();
        // label (fade in ~220ms after first appear / recognition change)
        const labelAlpha = Math.min(1, (now - v.labelAppearTs) / 220);
        if (labelAlpha <= 0.01) continue;
        const who = v.student_id
          ? (nameMapRef.current.get(v.student_id)?.name ?? v.student_id)
          : v.student_id;
        const label = known ? `${who} · ${v.score.toFixed(2)}` : `#${v.track_id}`;
        const pad = 6;
        const tw = ctx.measureText(label).width + pad * 2;
        const th = 20;
        ctx.fillStyle = `rgba(11,17,32,${(0.78 * labelAlpha).toFixed(3)})`;
        ctx.fillRect(rx, Math.max(0, ry - th), tw, th);
        const [lr, lg, lb] = known ? [52, 211, 153] : [251, 191, 36];
        ctx.fillStyle = `rgba(${lr},${lg},${lb},${labelAlpha.toFixed(3)})`;
        ctx.fillText(label, rx + pad, Math.max(12, ry - 6));
      }
    };
    const raf = () => {
      draw();
      rafId = requestAnimationFrame(raf);
    };
    let rafId = requestAnimationFrame(raf);
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const pushToast = useCallback((text: string, kind: WsTransition["kind"]) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev.slice(-3), { id, text, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const handleWsMessage = useCallback(
    (ev: MessageEvent) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        // Each frame gets exactly one result/error back — free an in-flight slot
        // so the sender paces to the backend instead of building a backlog.
        if (data?.type === "result" || data?.type === "error") {
          inflightRef.current = Math.max(0, inflightRef.current - 1);
        }
        if (data?.type !== "result") return;
        const msg = data as WsResult;
        // The pipeline omits sent_size; startSending already tracks the exact
        // transmitted size, so only honour a server value when present — never
        // clobber the local scale with undefined (that NaN'd the overlay draw).
        if (msg.sent_size) sentRef.current = msg.sent_size;
        lastResultAtRef.current = performance.now();
        const now = performance.now();
        const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
        const seen = new Set<number>();
        for (const f of msg.faces) {
          seen.add(f.track_id);
          const cur = tracksRef.current.get(f.track_id);
          if (!cur) {
            tracksRef.current.set(f.track_id, {
              prev: [...f.box] as [number, number, number, number],
              target: [...f.box] as [number, number, number, number],
              targetTs: now,
              appearTs: now,
              labelAppearTs: now,
              student_id: f.student_id,
              score: f.score,
              track_id: f.track_id,
              lastSeenTs: now,
            });
          } else {
            // Snapshot the currently-interpolated position as the new prev.
            const kt = Math.min(1, (now - cur.targetTs) / 120);
            const k = easeOut(kt);
            cur.prev = [
              cur.prev[0] + (cur.target[0] - cur.prev[0]) * k,
              cur.prev[1] + (cur.target[1] - cur.prev[1]) * k,
              cur.prev[2] + (cur.target[2] - cur.prev[2]) * k,
              cur.prev[3] + (cur.target[3] - cur.prev[3]) * k,
            ];
            cur.target = [...f.box] as [number, number, number, number];
            cur.targetTs = now;
            cur.lastSeenTs = now;
            // Re-fade the label whenever identity transitions unknown -> known.
            if (!cur.student_id && f.student_id) cur.labelAppearTs = now;
            cur.student_id = f.student_id;
            cur.score = f.score;
          }
        }
        // Drop tracks the server hasn't emitted for a while.
        for (const [id, v] of tracksRef.current) {
          if (!seen.has(id) && now - v.lastSeenTs > 800) tracksRef.current.delete(id);
        }
        setStale(false);
        if (msg.present) {
          // The lean contract sends bare id strings; the demo seed sends full
          // rows. Normalise both to WsPresentRow, resolving names + timing first
          // appearance locally so the panel never crashes on undefined fields.
          const nowSec = Date.now() / 1000;
          const rows: WsPresentRow[] = msg.present.map((p) => {
            if (typeof p !== "string") return p;
            const info = nameMapRef.current.get(p);
            if (!firstSeenRef.current.has(p)) firstSeenRef.current.set(p, nowSec);
            return {
              student_id: p,
              name: info?.name ?? p,
              reg_no: info?.reg_no ?? p,
              first_seen_ts: firstSeenRef.current.get(p) ?? nowSec,
            };
          });
          const still = new Set(rows.map((r) => r.student_id));
          for (const id of [...firstSeenRef.current.keys()])
            if (!still.has(id)) firstSeenRef.current.delete(id);
          setPresent(rows);
        }
        // Cumulative attendance: the backend sends the full attended set on
        // every result. Merge into state (never shrinks — attended is permanent).
        if (Array.isArray(msg.attended)) {
          setAttended(new Set(msg.attended));
        }
        for (const t of msg.transitions ?? []) {
          // Prefer a rich server shape; otherwise derive kind/name from the lean
          // {student_id, state} the pipeline currently emits.
          const name =
            t.name ??
            (t.student_id ? (nameMapRef.current.get(t.student_id)?.name ?? t.student_id) : "");
          const kind =
            t.kind ??
            (t.state === "PRESENT" ? "recognised" : t.state === "ABSENT" ? "leave" : undefined);
          if (!name || !kind) continue;
          if (kind === "enter") pushToast(`${name} entered`, "enter");
          else if (kind === "recognised") pushToast(`${name} recognised`, "recognised");
          else if (kind === "leave") pushToast(`${name} left`, "leave");
        }
      } catch {
        /* malformed WS payload — ignore this frame */
      }
    },
    [pushToast],
  );

  const openSocket = useCallback(() => {
    // Fresh connection: clear any in-flight accounting left over from a drop.
    inflightRef.current = 0;
    // Attach the WS pipeline to the active session so presence (and QR-window
    // verification) persist. Survives reconnects via the ref.
    const sid = sessionIdRef.current;
    const url = sid ? `${wsUrl}?session_id=${encodeURIComponent(sid)}` : wsUrl;
    try {
      setConn("RECONNECTING");
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConn("LIVE");
      ws.onmessage = handleWsMessage;
      ws.onclose = () => {
        setConn("OFFLINE");
        setStale(true);
        if (runningRef.current) {
          if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = window.setTimeout(openSocket, 2500);
        }
      };
      ws.onerror = () => {
        setConn("OFFLINE");
      };
    } catch {
      setConn("OFFLINE");
    }
  }, [handleWsMessage, wsUrl]);

  const startSending = useCallback(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const period = 1000 / Math.max(1, fps);
    const tick = async () => {
      const video = videoRef.current;
      const ws = wsRef.current;
      if (
        video &&
        video.videoWidth > 0 &&
        ws &&
        ws.readyState === WebSocket.OPEN &&
        ctx &&
        inflightRef.current < 2
      ) {
        const w = sendWidth;
        const h = Math.round((video.videoHeight / video.videoWidth) * w);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        // The backend detects on exactly this image, so its box coords are in
        // w×h space — record it so the overlay scales boxes to the display.
        sentRef.current = { w, h };
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        const b64 = dataUrl.split(",")[1] ?? "";
        const ts = (Date.now() - startEpochRef.current) / 1000;
        try {
          ws.send(JSON.stringify({ type: "frame", ts, jpg_b64: b64 }));
          inflightRef.current += 1;
        } catch {
          /* socket mid-close — drop this frame */
        }
      }
    };
    sendTimerRef.current = window.setInterval(tick, period);
  }, [fps, sendWidth]);

  const startRtspSession = useCallback(async () => {
    setPermError(null);
    try {
      // 1. Create a session on the backend
      const res = await fetch(`${API_BASE}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          class_section: CLASS_SECTION,
          subject: CLASS_SUBJECT,
          mode: "lecture",
        }),
      });
      if (!res.ok) throw new Error(`Session API ${res.status}: ${await res.text()}`);
      const session = await res.json();
      sessionIdRef.current = session.id;
      setRtspSessionId(session.id);

      // 2. Kick off the RTSP capture runner on the backend
      const startRes = await fetch(`${API_BASE}/v1/rtsp/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.id, mode: "lecture" }),
      });
      if (!startRes.ok) {
        const errText = await startRes.text();
        throw new Error(`RTSP start ${startRes.status}: ${errText}`);
      }

      startEpochRef.current = Date.now();
      setElapsed(0);
      setPresent([]);
      setRunning(true);
      setConn("LIVE");
      // In RTSP mode the backend drives the pipeline; no browser webcam or WS frame sending.
      // The frontend polls or uses Realtime for presence updates.
      openSocket();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "RTSP session failed";
      setPermError(message);
    }
  }, [openSocket]);

  const start = useCallback(async () => {
    if (isRtsp) return startRtspSession();
    setPermError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
      // Attach to a real class session so presence + the QR fallback persist.
      // Recognition still runs without one, but nothing would be recorded.
      try {
        const res = await fetch(`${API_BASE}/v1/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            class_section: CLASS_SECTION,
            subject: CLASS_SUBJECT,
            mode: "lecture",
          }),
        });
        if (res.ok) {
          const session = await res.json();
          sessionIdRef.current = session.id;
          setRtspSessionId(session.id);
        } else {
          // Non-fatal: recognition still runs, but presence + the QR fallback
          // won't attach. Surface it so a misconfigured backend isn't invisible.
          console.warn("session create failed", res.status, await res.text().catch(() => ""));
        }
      } catch (e) {
        console.warn("session attach failed — presence + QR disabled", e);
      }
      startEpochRef.current = Date.now();
      setElapsed(0);
      setPresent([]);
      setRunning(true);
      openSocket();
      startSending();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Camera unavailable";
      setPermError(message);
    }
  }, [deviceId, isRtsp, openSocket, startRtspSession, startSending]);

  const stop = useCallback(() => {
    // If an RTSP session is active, tell the backend to stop it
    if (rtspSessionId) {
      fetch(`${API_BASE}/v1/rtsp/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: rtspSessionId }),
      }).catch(() => {});
      fetch(`${API_BASE}/v1/sessions/${rtspSessionId}/end`, { method: "POST" }).catch(() => {});
      setRtspSessionId(null);
    }
    sessionIdRef.current = null;
    setAbsenteeOpen(false);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "end", ts: (Date.now() - startEpochRef.current) / 1000 }));
      } catch {
        /* already closing */
      }
      ws.close();
    }
    wsRef.current = null;
    if (sendTimerRef.current) {
      window.clearInterval(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRunning(false);
    setConn("OFFLINE");
    tracksRef.current.clear();
  }, [rtspSessionId]);

  // Run stop() only on real unmount. `stop` depends on rtspSessionId, which
  // start() sets the moment a session begins — if this effect depended on
  // `stop`'s identity, that change would fire the cleanup and tear the session
  // down the instant it started. Hold the latest stop in a ref instead.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => () => stopRef.current(), []);

  const toggleFs = useCallback(async () => {
    const el = wrapRef.current;
    if (!document.fullscreenElement && el) {
      await el.requestFullscreen?.().catch(() => {});
      setFullscreen(true);
    } else {
      await document.exitFullscreen?.().catch(() => {});
      setFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const time = useMemo(() => {
    const h = Math.floor(elapsed / 3600)
      .toString()
      .padStart(2, "0");
    const m = Math.floor((elapsed % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const s = Math.floor(elapsed % 60)
      .toString()
      .padStart(2, "0");
    return `${h}:${m}:${s}`;
  }, [elapsed]);

  return (
    <div ref={wrapRef} className="app-bg relative flex h-screen w-screen flex-col overflow-hidden">
      {/* Absentee QR fallback — teacher opens a verification window for the session.
          Sits ABOVE the footer (bottom-28) so the panel never covers End session. */}
      {running && rtspSessionId && (
        <div className="fixed bottom-28 right-6 z-40 w-75">
          {absenteeOpen ? (
            <AbsenteeQR
              sessionId={rtspSessionId}
              apiBase={API_BASE}
              onClose={() => setAbsenteeOpen(false)}
            />
          ) : (
            <button
              onClick={() => setAbsenteeOpen(true)}
              className="sp-btn sp-btn-secondary ml-auto flex"
            >
              <QrCode className="h-4 w-4" /> Absentee QR
            </button>
          )}
        </div>
      )}

      {/* Top HUD */}
      <header className="relative z-30 flex h-20 shrink-0 items-center gap-6 border-b border-[color:var(--line)] bg-[color:var(--bg)]/85 px-8 backdrop-blur">
        <div className="flex items-baseline gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--line)]"
            style={{ background: "linear-gradient(135deg, var(--primary-deep), var(--primary))" }}
          >
            <Camera className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              {CLASS_SECTION} · {CLASS_SUBJECT}
            </div>
            <div className="font-mono-nums text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              Room 201 · Board Kiosk · SensePro+
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4">
          {running && (
            <div className="flex items-center gap-2 rounded-md border border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10 px-3 py-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full bg-[color:var(--bad)]"
                style={{ animation: "sensepro-pulse 1.4s ease-in-out infinite" }}
              />
              <span className="font-mono-nums text-xs uppercase tracking-[0.2em] text-[color:var(--bad)]">
                Rec
              </span>
            </div>
          )}
          <div className="glass-panel-2 px-4 py-2">
            <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Session
            </div>
            <div className="font-mono-nums text-[26px] font-semibold leading-none text-[color:var(--ink)]">
              {time}
            </div>
          </div>
          <ConnectionBadge state={conn} />
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex h-12 w-12 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
            aria-label="Settings"
          >
            <Settings2 className="h-5 w-5" />
          </button>
          <button
            onClick={toggleFs}
            className="flex h-12 w-12 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
            aria-label="Fullscreen"
          >
            {fullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Stage */}
      <div className="relative flex min-h-0 flex-1">
        {/* Video stage */}
        <div className="relative flex min-h-0 flex-1 flex-col p-6">
          <div className="relative flex-1 overflow-hidden rounded-[14px] border border-[color:var(--line)] bg-black shadow-[var(--shadow-cobalt)]">
            {isRtsp ? (
              <div className="absolute inset-0 h-full w-full overflow-hidden bg-black">
                <img
                  src={`${API_BASE}/v1/rtsp/feed`}
                  alt="RTSP Camera Feed"
                  className="h-full w-full object-contain"
                />
                <div className="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-md border border-[color:var(--accent)]/40 bg-black/60 px-3 py-1.5 backdrop-blur-md">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--accent)] opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent)]" />
                  </span>
                  <span className="font-mono-nums text-xs text-white">
                    CP Plus RTSP · 10.101.40.189 {running ? "· LIVE SESSION" : "· PREVIEW"}
                  </span>
                </div>
              </div>
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            <canvas
              ref={overlayRef}
              className={cn(
                "pointer-events-none absolute inset-0 h-full w-full",
                isRtsp && "hidden",
              )}
            />

            {/* Scan line while running */}
            {running && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div
                  className="absolute left-0 right-0 h-[2px]"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgba(34,211,238,0.9), transparent)",
                    boxShadow: "0 0 24px rgba(34,211,238,0.6)",
                    animation: "sensepro-scan 4.5s linear infinite",
                  }}
                />
              </div>
            )}

            {/* Reconnecting / offline banner over the stage */}
            {running && conn !== "LIVE" && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="pointer-events-none absolute inset-x-0 top-6 z-10 flex justify-center"
              >
                <div
                  className={cn(
                    "glass-panel-2 flex items-center gap-3 px-4 py-2.5",
                    conn === "RECONNECTING"
                      ? "border-[color:var(--warn)]/50"
                      : "border-[color:var(--bad)]/60",
                  )}
                >
                  {conn === "RECONNECTING" ? (
                    <span
                      className="h-3 w-3 rounded-full border-2 border-[color:var(--warn)] border-t-transparent"
                      style={{ animation: "sensepro-spin 0.9s linear infinite" }}
                    />
                  ) : (
                    <span
                      className="h-2.5 w-2.5 rounded-full bg-[color:var(--bad)]"
                      style={{ animation: "sensepro-pulse 1.4s ease-in-out infinite" }}
                    />
                  )}
                  <div className="leading-tight">
                    <div
                      className={cn(
                        "font-mono-nums text-[11px] uppercase tracking-[0.22em]",
                        conn === "RECONNECTING"
                          ? "text-[color:var(--warn)]"
                          : "text-[color:var(--bad)]",
                      )}
                    >
                      {conn === "RECONNECTING"
                        ? "Reconnecting to inference"
                        : "Inference socket unreachable"}
                    </div>
                    <div className="font-mono-nums text-[10px] tracking-wider text-[color:var(--muted)]">
                      {conn === "RECONNECTING"
                        ? "Roster shown below is the last verified state · session continues"
                        : `${wsUrl} · will auto-retry`}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Empty / permission states */}
            {!running && !permError && <IdleState />}
            {permError && <ErrorState message={permError} onRetry={start} />}

            {/* Toasts */}
            <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
              <AnimatePresence>
                {toasts.map((t) => (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className={cn(
                      "glass-panel-2 px-3 py-2 font-mono-nums text-xs",
                      t.kind === "leave" ? "text-[color:var(--muted)]" : "text-[color:var(--ink)]",
                    )}
                  >
                    <span
                      className={cn(
                        "mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle",
                        t.kind === "enter" && "bg-[color:var(--accent)]",
                        t.kind === "recognised" && "bg-[color:var(--ok)]",
                        t.kind === "leave" && "bg-[color:var(--muted)]",
                      )}
                    />
                    {t.text}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Right rail: PRESENT NOW */}
        <aside
          className={cn(
            "relative flex w-[360px] shrink-0 flex-col border-l border-[color:var(--line)] bg-[color:var(--surface)]/70 backdrop-blur transition-opacity",
            stale && "opacity-95",
          )}
        >
          {/* Diagonal STALE ROSTER watermark */}
          {stale && running && (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
              <div
                aria-hidden
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(135deg, transparent 0 22px, rgba(251,191,36,0.06) 22px 24px)",
                }}
              >
                <div
                  className="font-display text-4xl font-black uppercase tracking-[0.35em] text-[color:var(--warn)]/25"
                  style={{ transform: "rotate(-24deg)" }}
                >
                  Stale · Roster
                </div>
              </div>
              <div className="absolute inset-x-3 top-3 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-3 py-2">
                <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--warn)]">
                  Roster frozen · awaiting inference
                </div>
                <div className="mt-0.5 font-mono-nums text-[10px] text-[color:var(--muted)]">
                  Last update{" "}
                  {lastResultAtRef.current
                    ? `${Math.floor((performance.now() - lastResultAtRef.current) / 1000)}s ago`
                    : "—"}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-b border-[color:var(--line)] px-6 py-5">
            <div className="flex gap-6">
              <div>
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Present now
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <div className="font-display text-4xl font-extrabold leading-none tracking-tight text-[color:var(--ink)]">
                    {present.length.toString().padStart(2, "0")}
                  </div>
                  <div className="font-mono-nums text-sm text-[color:var(--muted)]">
                    / {rosterHint.enrolled}
                  </div>
                </div>
              </div>
              <div>
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--ok)]">
                  Attended
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <div className="font-display text-4xl font-extrabold leading-none tracking-tight text-[color:var(--ok)]">
                    {attended.size.toString().padStart(2, "0")}
                  </div>
                  <div className="font-mono-nums text-sm text-[color:var(--muted)]">
                    / {rosterHint.enrolled}
                  </div>
                </div>
              </div>
            </div>
            {running && <span className="pulse-dot" />}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {present.length === 0 ? (
              <div className="mx-3 mt-6 rounded-md border border-dashed border-[color:var(--line)] p-6 text-center">
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Awaiting recognitions
                </div>
                <div className="mt-2 text-sm text-[color:var(--muted)]">
                  Once faces are matched they appear here in real time.
                </div>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                <AnimatePresence initial={false}>
                  {present.map((p) => (
                    <motion.li
                      key={p.student_id}
                      layout
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 16 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 hover:border-[color:var(--line)] hover:bg-[color:var(--surface-2)]/60"
                    >
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[color:var(--line)] font-mono-nums text-xs font-semibold text-[color:var(--ink)]"
                        style={{
                          background: "linear-gradient(135deg, var(--surface-2), var(--surface))",
                        }}
                      >
                        {initials(p.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[18px] font-medium text-[color:var(--ink)]">
                          {p.name}
                        </div>
                        <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
                          {p.reg_no}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <div className="font-mono-nums text-[11px] text-[color:var(--ok)]">
                          {tsAgo(p.first_seen_ts)}
                        </div>
                        {attended.has(p.student_id) && (
                          <div className="font-mono-nums text-[9px] uppercase tracking-[0.15em] text-[color:var(--ok)]">
                            ✓ attended
                          </div>
                        )}
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </aside>

        {/* Settings sheet */}
        <AnimatePresence>
          {settingsOpen && (
            <motion.div
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 20, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="absolute right-6 top-24 z-40 w-[380px] glass-panel p-5"
            >
              <div className="flex items-center justify-between">
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Capture settings
                </div>
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                  aria-label="Close settings"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="mb-1 font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                    Camera source
                  </div>
                  <select
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    className="sp-focus h-12 w-full rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 font-mono-nums text-xs text-[color:var(--ink)] outline-none focus:border-[color:var(--primary)]"
                  >
                    {cameras.length === 0 && <option value="">System default</option>}
                    {cameras.map((c) => (
                      <option key={c.deviceId} value={c.deviceId}>
                        {c.label || c.deviceId.slice(0, 8)}
                      </option>
                    ))}
                    <option value={RTSP_SOURCE}>📹 {RTSP_LABEL}</option>
                  </select>
                  {isRtsp && (
                    <div className="mt-2 flex items-center gap-2 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-3 py-2">
                      <Video className="h-4 w-4 text-[color:var(--accent)]" />
                      <div className="text-[11px] leading-snug text-[color:var(--muted)]">
                        RTSP mode — the backend pulls frames from the physical camera. No browser
                        webcam is used.
                      </div>
                    </div>
                  )}
                </div>
                <NumberRow
                  label="Send width (px)"
                  value={sendWidth}
                  onChange={setSendWidth}
                  min={480}
                  max={1920}
                  step={320}
                />
                <NumberRow
                  label="Frames / second"
                  value={fps}
                  onChange={setFps}
                  min={0.5}
                  max={4}
                  step={0.5}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Disclosure line */}
      <div className="border-t border-[color:var(--line)] bg-[color:var(--surface)]/60 px-8 py-2 text-center font-mono-nums text-[11px] tracking-wider text-[color:var(--muted)]">
        This classroom uses camera-based attendance. Frames are processed in memory and never
        stored. Details from your teacher.
      </div>

      {/* Bottom bar */}
      <footer className="flex h-24 shrink-0 items-center justify-between border-t border-[color:var(--line)] bg-[color:var(--bg)]/85 px-8 backdrop-blur">
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
          {running ? "Session in progress" : "Session idle"}
        </div>
        <div className="flex items-center gap-3">
          {!running ? (
            <button
              onClick={start}
              className="flex h-14 items-center gap-3 rounded-md bg-[color:var(--primary)] px-8 text-base font-semibold tracking-wide text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
            >
              <Play className="h-5 w-5" fill="currentColor" />
              Start session
            </button>
          ) : (
            <button
              onClick={stop}
              className="flex h-14 items-center gap-3 rounded-md border border-[color:var(--bad)]/60 bg-[color:var(--bad)]/10 px-8 text-base font-semibold tracking-wide text-[color:var(--bad)] transition-colors hover:bg-[color:var(--bad)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bad)]"
            >
              <StopIcon className="h-5 w-5" fill="currentColor" />
              End session
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function IdleState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-black/40 via-black/20 to-black/40">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--line)]"
        style={{ background: "linear-gradient(135deg, var(--surface-2), var(--surface))" }}
      >
        <Camera className="h-7 w-7 text-[color:var(--muted)]" />
      </div>
      <div className="font-display text-3xl font-extrabold tracking-tight text-[color:var(--ink)]">
        Kiosk standby
      </div>
      <div className="max-w-md text-center text-sm text-[color:var(--muted)]">
        Press <span className="font-mono-nums text-[color:var(--ink)]">Start session</span> to open
        the camera and connect the inference socket.
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 px-6 text-center">
      <div className="font-mono-nums text-[11px] uppercase tracking-[0.22em] text-[color:var(--bad)]">
        Camera unavailable
      </div>
      <div className="max-w-lg text-[color:var(--ink)]">{message}</div>
      <div className="max-w-md text-sm text-[color:var(--muted)]">
        Check camera permission for this browser, then retry. If no camera is attached, plug in the
        board's USB feed.
      </div>
      <button
        onClick={onRetry}
        className="mt-2 flex h-12 items-center gap-2 rounded-md bg-[color:var(--primary)] px-5 text-sm font-semibold text-white hover:bg-[color:var(--primary-deep)]"
      >
        Retry
      </button>
    </div>
  );
}

function NumberRow({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          {label}
        </div>
        <div className="font-mono-nums text-xs text-[color:var(--ink)]">{value}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, value - step))}
          aria-label={`Decrease ${label}`}
          className="sp-focus h-12 w-12 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--ink)] transition-colors hover:bg-[color:var(--surface)]"
        >
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="sp-focus h-2 flex-1 accent-[color:var(--primary)]"
        />
        <button
          onClick={() => onChange(Math.min(max, value + step))}
          aria-label={`Increase ${label}`}
          className="sp-focus h-12 w-12 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--ink)] transition-colors hover:bg-[color:var(--surface)]"
        >
          +
        </button>
      </div>
    </div>
  );
}

function initials(n?: string | null) {
  if (!n) return "?";
  return n
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function tsAgo(t: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}
