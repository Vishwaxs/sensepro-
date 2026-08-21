import { createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Camera,
  CheckCircle2,
  Eye,
  Maximize2,
  Minimize2,
  Move,
  Play,
  Presentation,
  QrCode,
  Save,
  Settings2,
  ShieldAlert,
  Smartphone,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import { AbsenteeQR } from "@/components/sp/AbsenteeQR";
import { ConnectionBadge, type ConnState } from "@/components/sp/ConnectionBadge";
import { cn } from "@/lib/utils";
import { guardRoute } from "@/lib/auth-guard";
import { API_BASE, authHeader, getAuthToken } from "@/lib/api";
import { cameraBlockReason, describeCameraError } from "@/lib/camera";

// Sentinel device ID for the backend-side RTSP camera source.
const RTSP_SOURCE = "__rtsp__";
const RTSP_LABEL = "CP Plus RTSP · 10.101.40.189";

// The class this capture station records for. class_section MUST match the
// students' class_section in Supabase — the QR claim rejects any student whose
// class differs (403). Override per deployment via env.
const CLASS_SECTION = import.meta.env.VITE_CLASS_SECTION || "MCA-4B";
const CLASS_SUBJECT = import.meta.env.VITE_CLASS_SUBJECT || "Distributed Systems";

type SessionMode = "lecture" | "exam" | "workshop";

export const Route = createFileRoute("/capture")({
  beforeLoad: guardRoute(["teacher"]),
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
interface SessionRosterEntry {
  student_id: string;
  name: string;
  reg_no: string;
  first_seen_ts: number;
  last_seen_ts: number;
  isLive: boolean;
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
// Exam-mode proctor + engagement live views — sent once a session_id is
// attached (proctor only in exam mode; see app/ws.py). Detections/flags carry
// the SAME raw student_id faces[] does (reg_no or students.id, never a name);
// names are resolved locally via nameMapRef, matching the rest of this file.
interface WsProctorDet {
  label: string; // "cell phone" | "person"
  box: [number, number, number, number];
  confidence: number;
  student_id: string | null;
}
interface WsProctorFlag {
  flag_type: string; // "phone" | "extra_person" | "head_pose" | "other"
  student_id: string | null;
  id?: string;
  flagged_at?: string;
  ts?: number;
}
interface WsProctorPose {
  track_id?: number;
  student_id?: string | null;
  yaw?: number | null;
  pitch?: number | null;
  state?: string | null;
  label?: string | null;
}
interface WsProctor {
  detections: WsProctorDet[];
  flags: WsProctorFlag[]; // flags raised THIS frame only
  backend?: string | null;
  ready?: boolean;
  poses?: WsProctorPose[];
}
interface WsEngagement {
  visible: number;
  attending: number;
  head_down: number;
  phone: number | null;
  vnei: number | null; // null when suppressed or nobody visible — never estimated
  k_min: number;
  suppressed: boolean; // below the k-anonymity floor
  suppression_reason?: "privacy_floor" | "insufficient_pose_observations" | string | null;
  phone_detector?: {
    backend?: string | null;
    ready?: boolean;
    production?: boolean;
    error?: string | null;
  };
  observable?: number;
  still?: number;
  moving?: number;
  window?: {
    state?: string;
    window_s?: number;
    elapsed_s?: number;
    remaining_s?: number;
    completed_windows?: number;
    last_window?: {
      state?: string;
      window_start?: string;
      reported_zones?: string[];
      withheld_zones?: Record<string, string>;
    } | null;
  };
  // Legacy/alternate transports may flatten these fields. Keep accepting them
  // while preferring the backend's nested `window` contract.
  window_s?: number;
  persisted?: boolean | number;
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
  proctor?: WsProctor;
  engagement?: WsEngagement;
  // Optional: the current pipeline omits it — startSending tracks sent size locally.
  sent_size?: { w: number; h: number };
}
interface ProctorAlert {
  id: string;
  type: string;
  name: string | null;
  ts: number;
}

interface ProctorLiveState {
  phone: boolean;
  phoneOwner: string | null;
  backend: string | null;
  ready: boolean | null;
  poses: WsProctorPose[];
}

interface RtspStatusPayload {
  status?: string;
  running?: boolean;
  error?: string | null;
  proctor?: WsProctor;
  engagement?: WsEngagement;
}

interface SavedSummary {
  present: number;
  total: number;
  candidates: number;
  flags: number;
  elapsed: number;
  engagement: WsEngagement | null;
  confirmed: boolean;
  warning?: string;
}

/** Build the capture WebSocket URL.
 *
 *  Default, and all of local dev: same-origin through the Vite `/api` proxy,
 *  which forwards WS upgrades to the backend. The socket then always matches
 *  the page's own protocol + host, so an https page (tunnel) gets `wss` and the
 *  browser's mixed-content rule can never block it, while localhost /
 *  127.0.0.1 / a tunnel hostname each resolve to whatever actually served the
 *  page.
 *
 *  Production has no such proxy. A static host (Vercel, Netlify, Cloudflare
 *  Pages, Render's `static` runtime) serves the built assets from a CDN and
 *  cannot forward an Upgrade request to the API, so same-origin
 *  /api/ws/capture reaches the CDN and stops there — which is why /capture was
 *  the one screen that did not survive a static deploy. An absolute
 *  `wss://api.example.com/ws/capture` in VITE_WS_URL is therefore honoured, and
 *  is the intended production wiring: the browser opens the socket against the
 *  API host directly.
 *
 *  Absolute URLs were originally refused because of mixed content — a `ws://`
 *  socket opened from an `https://` page is blocked outright, which in dev
 *  looked like a silent, unexplained disconnect. That is now handled directly
 *  instead of by banning the form: on a secure page the scheme is upgraded to
 *  `wss:` and the substitution is logged, so a misconfigured env var degrades
 *  into a working socket rather than an invisible failure. */
function resolveWsUrl(): string {
  const raw = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  const pageIsSecure = window.location.protocol === "https:";

  if (raw && /^wss?:\/\//i.test(raw)) {
    const abs = new URL(raw);
    if (pageIsSecure && abs.protocol === "ws:") {
      abs.protocol = "wss:";
      console.warn(
        "[capture] VITE_WS_URL is ws:// but this page is https. A mixed-content socket is " +
          `blocked by the browser, so it was upgraded to ${abs.origin}. Set VITE_WS_URL to ` +
          "wss:// to silence this.",
      );
    }
    return abs.toString();
  }

  const path = raw && raw.startsWith("/") ? raw : "/api/ws/capture";
  const proto = pageIsSecure ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** Session mode from the start wizard. Opening /capture directly stays lecture. */
function captureMode(): SessionMode {
  if (typeof window === "undefined") return "lecture";
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "exam" || mode === "workshop" ? mode : "lecture";
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
  // Live proctor detections for the overlay (exam mode). `atMs` lets the draw
  // loop fade the boxes out when the phone leaves frame.
  const proctorRef = useRef<{ dets: WsProctorDet[]; atMs: number }>({ dets: [], atMs: 0 });
  const lastRtspFlagSignatureRef = useRef("");
  // Save-and-end flow: `stoppingRef` stops the socket auto-reconnecting after
  // an intentional end; `endAckRef` is the finalize callback fired when the
  // server acks the end (or on a timeout fallback).
  const stoppingRef = useRef(false);
  const endAckRef = useRef<null | (() => void)>(null);
  // Mirrors `present` for saveAndEnd (avoids a stale closure on click and
  // avoids recreating the callback on every WS message).
  const presentRef = useRef<WsPresentRow[]>([]);
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
  // 1920, not 1280. Measured on the 44 real 4K classroom frames: at 1280 the
  // median face is 23 px tall and 13 of 25 faces fall under 24 px, which ArcFace
  // cannot identify reliably (match rate 31%). At 1920 the median is 35 px, only
  // 1 face is under 24 px, and the match rate rises to 38.5% — for +114 ms of
  // detection per frame, because cost is dominated by re-ID, not by resolution.
  const [sendWidth, setSendWidth] = useState(1920);
  const [fps, setFps] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [conn, setConn] = useState<ConnState>("OFFLINE");
  // Counts consecutive failed connect attempts so the banner can tell "the
  // backend is probably still warming up its vision model" (first few tries —
  // the InsightFace model load blocks uvicorn's startup on purpose, see
  // backend/app/main.py's lifespan) apart from "something is actually wrong"
  // (sustained failures). Reset to 0 on a successful open.
  const [wsAttempt, setWsAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  // Resolved after mount only: window.isSecureContext doesn't exist during the
  // SSR/prerender pass, and guessing there would flash a wrong warning.
  const [cameraBlocked, setCameraBlocked] = useState<string | null>(null);
  // The MJPEG feed is staff-gated, but an <img> cannot carry an Authorization
  // header, so the access token rides along as a query parameter instead (see
  // backend/app/rtsp_api.py rtsp_feed). Held in state because getSession() is
  // async and the <img> needs a concrete URL at render time.
  const [feedToken, setFeedToken] = useState<string | null>(null);
  // Same token, in a ref: openSocket is a useCallback that reconnects on a
  // timer, and reading state there would capture a stale value.
  const accessTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAuthToken().then((token) => {
      if (!cancelled && token) {
        setFeedToken(token);
        accessTokenRef.current = token;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [present, setPresent] = useState<WsPresentRow[]>([]);
  const [sessionRoster, setSessionRoster] = useState<SessionRosterEntry[]>([]);
  const sessionRosterRef = useRef<Map<string, SessionRosterEntry>>(new Map());
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
  // Exam-mode proctoring surfaced to the operator: a running log of raised
  // flags and whether a phone is on screen *right now*, with its likely owner.
  const [proctorFlags, setProctorFlags] = useState<ProctorAlert[]>([]);
  const [proctorLive, setProctorLive] = useState<ProctorLiveState>({
    phone: false,
    phoneOwner: null,
    backend: null,
    ready: null,
    poses: [],
  });
  // Set true the first time the server sends a `proctor` view (exam mode) —
  // server-driven, not client-guessed, so the panel appears correctly even if
  // /capture was opened directly without the /start wizard's ?mode=exam.
  const [examMode, setExamMode] = useState(false);
  // Live class-level engagement (aggregate; null until the server sends it).
  const [engagement, setEngagement] = useState<WsEngagement | null>(null);
  // Set when a session is saved & ended — drives the confirmation overlay.
  const [savedSummary, setSavedSummary] = useState<SavedSummary | null>(null);
  const [rtspStatus, setRtspStatus] = useState<string | null>(null);
  const [rtspStatusError, setRtspStatusError] = useState<string | null>(null);

  const isRtsp = deviceId === RTSP_SOURCE;
  const [rosterHint, setRosterHint] = useState({ enrolled: 53 });
  // Capture socket URL: same-origin via the /api proxy in dev, or the absolute
  // wss:// API host in production (see resolveWsUrl). Computed once; "" during
  // SSR (no window) — the socket only ever opens client-side.
  const wsUrl = useMemo(() => (typeof window === "undefined" ? "" : resolveWsUrl()), []);

  // Session context comes from the /start wizard via the URL. Opening
  // /capture directly (no wizard) falls back to the deployment's env-var
  // defaults, same as before the wizard existed.
  const [sessionInfo] = useState(() => {
    const p =
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search);
    const rawMode = p.get("mode");
    return {
      title: p.get("title") || CLASS_SUBJECT,
      section: p.get("section") || CLASS_SECTION,
      room: p.get("room") || "Room 201 · Board Kiosk",
      // The operating mode controls the capture contract as well as the label;
      // workshop must remain distinct so its UI stays anonymous and aggregate-only.
      mode: (rawMode === "exam"
        ? "exam"
        : rawMode === "workshop"
          ? "workshop"
          : "lecture") as SessionMode,
    };
  });
  const isLectureMode = sessionInfo.mode === "lecture";
  const isExamMode = sessionInfo.mode === "exam";
  const isWorkshopMode = sessionInfo.mode === "workshop";

  // Adopt a session id the wizard already created, so start()/startRtspSession
  // don't open a second one for the same session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sid = new URLSearchParams(window.location.search).get("session_id");
    if (sid) {
      sessionIdRef.current = sid;
      setRtspSessionId(sid);
    }
  }, []);

  // (Removed: a ?demo=stale helper that seeded five invented students and
  // forced running+RECONNECTING+stale without ever opening a socket. It put the
  // kiosk in a state that never resolves and is indistinguishable from a real
  // outage, and it put fabricated names on screen — which this project does not
  // do. The stale watermark is reviewable by pulling the backend instead.)

  // Can this origin open a camera at all? (Non-secure origins can't — see
  // lib/camera.ts.) Checked on mount so the kiosk says so up front.
  useEffect(() => {
    setCameraBlocked(cameraBlockReason());
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
    // Workshop is deliberately aggregate-only. Do not resolve participant ids
    // to names in the browser when the workspace never needs an identity roster.
    if (isWorkshopMode) {
      nameMapRef.current = new Map();
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/roster?class_section=${encodeURIComponent(sessionInfo.section)}`,
          { headers: await authHeader() },
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
  }, [isWorkshopMode, sessionInfo.section]);

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

  // RTSP inference runs in a backend thread, so it cannot return telemetry on
  // the browser frame socket. Poll its authenticated status endpoint while the
  // source is active. Older backends may not expose the endpoint yet; a 404 is
  // tolerated without turning a healthy video feed into an error state.
  useEffect(() => {
    if (!isRtsp || !running || !rtspSessionId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE}/v1/rtsp/status/${rtspSessionId}`, {
          headers: await authHeader(),
        });
        if (cancelled || response.status === 404) return;
        if (!response.ok) throw new Error(`RTSP status ${response.status}`);

        const payload = (await response.json()) as RtspStatusPayload;
        if (cancelled) return;
        setRtspStatus(payload.status ?? (payload.running === false ? "stopped" : "running"));
        setRtspStatusError(payload.error ?? null);

        if (payload.proctor && isExamMode) {
          setExamMode(true);
          const dets = payload.proctor.detections ?? [];
          proctorRef.current = { dets, atMs: performance.now() };
          const phoneDet = dets.find((d) => d.label === "cell phone");
          setProctorLive({
            phone: !!phoneDet,
            phoneOwner: phoneDet?.student_id
              ? (nameMapRef.current.get(phoneDet.student_id)?.name ?? phoneDet.student_id)
              : null,
            backend: payload.proctor.backend ?? null,
            ready: payload.proctor.ready ?? null,
            poses: payload.proctor.poses ?? [],
          });

          const flags = payload.proctor.flags ?? [];
          const signature = JSON.stringify(flags);
          if (flags.length > 0 && signature !== lastRtspFlagSignatureRef.current) {
            lastRtspFlagSignatureRef.current = signature;
            setProctorFlags((previous) => {
              const additions = flags.map((flag) => ({
                id: flag.id ?? crypto.randomUUID(),
                type: flag.flag_type,
                name: flag.student_id
                  ? (nameMapRef.current.get(flag.student_id)?.name ?? flag.student_id)
                  : null,
                ts: flag.flagged_at
                  ? Date.parse(flag.flagged_at) / 1000
                  : (flag.ts ?? Date.now() / 1000),
              }));
              const ids = new Set(additions.map((flag) => flag.id));
              return [...additions, ...previous.filter((flag) => !ids.has(flag.id))].slice(0, 50);
            });
          }
        }

        if (payload.engagement) setEngagement(payload.engagement);
      } catch (error) {
        if (!cancelled) {
          setRtspStatusError(error instanceof Error ? error.message : "RTSP status unavailable");
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isExamMode, isRtsp, rtspSessionId, running]);

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
      const sx = w / sentRef.current.w;
      const sy = h / sentRef.current.h;
      const now = performance.now();

      // --- Phone overlay (exam mode): a detected phone gets a pulsing red
      // box + confidence, drawn before faces so it shows even with no track. ---
      const pv = proctorRef.current;
      if (pv.dets.length && now - pv.atMs < 1200) {
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(now / 190));
        ctx.font = '700 12px "IBM Plex Mono", monospace';
        for (const d of pv.dets) {
          if (d.label !== "cell phone") continue;
          const [x0, y0, x1, y1] = d.box;
          const rx = x0 * sx;
          const ry = y0 * sy;
          const rw = (x1 - x0) * sx;
          const rh = (y1 - y0) * sy;
          ctx.lineWidth = 3;
          ctx.strokeStyle = `rgba(244,63,94,${pulse.toFixed(3)})`;
          ctx.strokeRect(rx, ry, rw, rh);
          const who = d.student_id
            ? ` · ${nameMapRef.current.get(d.student_id)?.name ?? d.student_id}`
            : "";
          const label = `PHONE ${(d.confidence * 100).toFixed(0)}%${who}`;
          const tw = ctx.measureText(label).width + 12;
          ctx.fillStyle = "rgba(244,63,94,0.94)";
          ctx.fillRect(rx, Math.max(0, ry - 20), tw, 20);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, rx + 6, Math.max(12, ry - 6));
        }
      }

      const tracks = tracksRef.current;
      if (tracks.size === 0) return;
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
        const label = isWorkshopMode
          ? `PARTICIPANT · ${v.track_id.toString().padStart(2, "0")}`
          : known
            ? `${who} · ${v.score.toFixed(2)}`
            : `#${v.track_id}`;
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
  }, [isWorkshopMode]);

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
        // The server acked our end request — attendance intervals are closed.
        if (data?.type === "session_ended") {
          if (endAckRef.current) {
            endAckRef.current();
            endAckRef.current = null;
          }
          return;
        }
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
          const rows: WsPresentRow[] = isWorkshopMode
            ? msg.present.map((_, index) => ({
                student_id: `participant-${index + 1}`,
                name: "Participant",
                reg_no: "",
                first_seen_ts: nowSec,
              }))
            : msg.present.map((p) => {
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
          const liveIds = new Set(rows.map((r) => r.student_id));
          for (const id of [...firstSeenRef.current.keys()]) {
            if (!liveIds.has(id)) firstSeenRef.current.delete(id);
          }
          setPresent(rows);
          presentRef.current = rows;

          if (!isWorkshopMode) {
            // Lecture and exam keep a session roster for their mode-specific rails.
            const rosterMap = sessionRosterRef.current;
            for (const r of rows) {
              const existing = rosterMap.get(r.student_id);
              if (existing) {
                existing.last_seen_ts = nowSec;
                existing.isLive = true;
                if (r.name && r.name !== r.student_id) existing.name = r.name;
                if (r.reg_no && r.reg_no !== r.student_id) existing.reg_no = r.reg_no;
              } else {
                rosterMap.set(r.student_id, {
                  student_id: r.student_id,
                  name: r.name,
                  reg_no: r.reg_no,
                  first_seen_ts: r.first_seen_ts,
                  last_seen_ts: nowSec,
                  isLive: true,
                });
              }
            }
            for (const [id, entry] of rosterMap.entries()) {
              if (!liveIds.has(id)) entry.isLive = false;
            }
            setSessionRoster(Array.from(rosterMap.values()));
          }
        }
        // Cumulative attendance: the backend sends the full attended set on
        // every result. Merge into state (never shrinks — attended is permanent).
        if (!isWorkshopMode && Array.isArray(msg.attended)) {
          const attendedSet = new Set(msg.attended);
          setAttended(attendedSet);
          const rosterMap = sessionRosterRef.current;
          let changed = false;
          const nowSec = Date.now() / 1000;
          for (const sid of msg.attended) {
            if (!rosterMap.has(sid)) {
              const info = nameMapRef.current.get(sid);
              rosterMap.set(sid, {
                student_id: sid,
                name: info?.name ?? sid,
                reg_no: info?.reg_no ?? sid,
                first_seen_ts: nowSec,
                last_seen_ts: nowSec,
                isLive: false,
              });
              changed = true;
            }
          }
          if (changed) {
            setSessionRoster(Array.from(rosterMap.values()));
          }
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
          const displayName = isWorkshopMode ? "Participant" : name;
          if (kind === "enter") pushToast(`${displayName} entered view`, "enter");
          else if (kind === "recognised")
            pushToast(
              isWorkshopMode ? "Participant signal acquired" : `${displayName} recognised`,
              "recognised",
            );
          else if (kind === "leave") pushToast(`${displayName} left view`, "leave");
        }

        // Proctor (exam mode): stash detections for the overlay, reflect live
        // phone state (and who holds it), and log any flag actually raised.
        if (msg.proctor && isExamMode) {
          setExamMode(true);
          const dets = msg.proctor.detections ?? [];
          proctorRef.current = { dets, atMs: now };
          const phoneDet = dets.find((d) => d.label === "cell phone");
          setProctorLive({
            phone: !!phoneDet,
            phoneOwner: phoneDet?.student_id
              ? (nameMapRef.current.get(phoneDet.student_id)?.name ?? phoneDet.student_id)
              : null,
            backend: msg.proctor.backend ?? null,
            ready: msg.proctor.ready ?? null,
            poses: msg.proctor.poses ?? [],
          });
          for (const f of msg.proctor.flags ?? []) {
            const name = f.student_id
              ? (nameMapRef.current.get(f.student_id)?.name ?? f.student_id)
              : null;
            setProctorFlags((prev) => [
              { id: crypto.randomUUID(), type: f.flag_type, name, ts: Date.now() / 1000 },
              ...prev.slice(0, 49),
            ]);
            pushToast(`${proctorEventLabel(f.flag_type)}${name ? ` · ${name}` : ""}`, "leave");
          }
        }

        // Class-level engagement (aggregate; suppressed below the k-anonymity
        // floor server-side — never estimated here).
        if (msg.engagement) {
          setEngagement(msg.engagement);
        }
      } catch {
        /* malformed WS payload — ignore this frame */
      }
    },
    [isExamMode, isWorkshopMode, pushToast],
  );

  const openSocket = useCallback(async () => {
    // Fresh connection: clear any in-flight accounting left over from a drop.
    inflightRef.current = 0;
    // Attach the WS pipeline to the active session so presence (and QR-window
    // verification) persist. Survives reconnects via the ref. `mode` gates
    // exam-mode proctoring server-side (see app/ws.py).
    const sid = sessionIdRef.current;
    const params = new URLSearchParams({ mode: captureMode() });
    if (sid) params.set("session_id", sid);
    // The capture socket is staff-gated server-side (backend/app/ws.py): it
    // drives the attendance write path and every frame costs model inference.
    // A WebSocket handshake cannot carry an Authorization header, so the
    // short-lived access token travels as a query parameter, same as the MJPEG
    // feed. Without it the server closes the socket with 1008.
    let token = accessTokenRef.current;
    if (!token) {
      token = await getAuthToken();
      if (token) {
        accessTokenRef.current = token;
        setFeedToken(token);
      }
    }
    if (token) params.set("token", token);
    // VITE_WS_URL may legitimately carry its own query string in production
    // (a host that routes on one), so pick the separator instead of always
    // appending "?" and producing a second, ignored query.
    const url = `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}${params.toString()}`;
    try {
      setConn("RECONNECTING");
      setWsAttempt((n) => n + 1);
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setConn("LIVE");
        setWsAttempt(0);
      };
      ws.onmessage = handleWsMessage;
      ws.onclose = () => {
        setConn("OFFLINE");
        setStale(true);
        // Don't reconnect if we're intentionally ending the session.
        if (runningRef.current && !stoppingRef.current) {
          if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = window.setTimeout(() => void openSocket(), 2500);
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
        // 0.85, not 0.6. JPEG artefacts land hardest on the small back-row
        // faces this system exists to recognise. Same frames, same detector,
        // only quality varied: q60 -> 38.9% matched (median score 0.370),
        // q75 -> 46.1%, q85 -> 48.9% (0.431), q95 -> 48.9% for double the
        // bytes. 0.85 is where the curve flattens: +10 points of match rate
        // over q60 for ~265 KB/frame, i.e. ~2 Mbit/s at 1 fps.
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
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
      const mode = captureMode();
      // 1. Reuse the session the /start wizard already created; only open one
      // here if the user came straight to /capture (bookmark, demo, etc).
      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        const headers = await authHeader();
        const res = await fetch(`${API_BASE}/v1/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            class_section: sessionInfo.section,
            subject: sessionInfo.title,
            mode,
          }),
        });
        if (!res.ok) throw new Error(`Session API ${res.status}: ${await res.text()}`);
        sessionId = (await res.json()).id;
      }
      sessionIdRef.current = sessionId;
      setRtspSessionId(sessionId);

      // 2. Kick off the RTSP capture runner on the backend
      const headers = await authHeader();
      const startRes = await fetch(`${API_BASE}/v1/rtsp/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ session_id: sessionId, mode }),
      });
      if (!startRes.ok) {
        const errText = await startRes.text();
        throw new Error(`RTSP start ${startRes.status}: ${errText}`);
      }

      startEpochRef.current = Date.now();
      setElapsed(0);
      setPresent([]);
      presentRef.current = [];
      setProctorFlags([]);
      setProctorLive({ phone: false, phoneOwner: null, backend: null, ready: null, poses: [] });
      setExamMode(false);
      setEngagement(null);
      proctorRef.current = { dets: [], atMs: 0 };
      lastRtspFlagSignatureRef.current = "";
      setSavedSummary(null);
      setRtspStatus("started");
      setRtspStatusError(null);
      stoppingRef.current = false;
      endAckRef.current = null;
      setRunning(true);
      setConn("LIVE");
      // In RTSP mode the backend drives the pipeline; no browser webcam or WS frame sending.
      // The frontend polls or uses Realtime for presence updates.
      void openSocket();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "RTSP session failed";
      setPermError(message);
    }
  }, [openSocket, sessionInfo]);

  const start = useCallback(async () => {
    if (isRtsp) return startRtspSession();
    setPermError(null);
    // Preflight BEFORE touching navigator.mediaDevices: on a non-secure origin
    // (e.g. the LAN URL Vite prints for the phone demo) the whole API is
    // undefined, and reaching it threw a bare TypeError that told the operator
    // nothing while the socket and API kept connecting normally.
    const blocked = cameraBlockReason();
    if (blocked) {
      setPermError(blocked);
      return;
    }
    try {
      const constraints = (exact: boolean): MediaStreamConstraints => ({
        video: {
          deviceId: deviceId && exact ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      // A remembered deviceId that no longer exists (camera unplugged, or a
      // different USB port) fails the `exact` constraint outright — fall back
      // to any camera rather than dead-ending the session.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(true));
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (!deviceId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw err;
        stream = await navigator.mediaDevices.getUserMedia(constraints(false));
      }
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
      // Reuse the session the /start wizard already created; only open one
      // here if the user came straight to /capture. Failing quietly keeps the
      // camera live (recognition still runs) even when the backend isn't
      // persisting.
      if (!sessionIdRef.current) {
        try {
          const headers = await authHeader();
          const res = await fetch(`${API_BASE}/v1/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({
              class_section: sessionInfo.section,
              subject: sessionInfo.title,
              mode: captureMode(),
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
      }
      startEpochRef.current = Date.now();
      setElapsed(0);
      setPresent([]);
      presentRef.current = [];
      sessionRosterRef.current.clear();
      setSessionRoster([]);
      setProctorFlags([]);
      setProctorLive({ phone: false, phoneOwner: null, backend: null, ready: null, poses: [] });
      setExamMode(false);
      setEngagement(null);
      proctorRef.current = { dets: [], atMs: 0 };
      lastRtspFlagSignatureRef.current = "";
      setSavedSummary(null);
      setRtspStatus(null);
      setRtspStatusError(null);
      stoppingRef.current = false;
      endAckRef.current = null;
      setRunning(true);
      openSocket();
      startSending();
    } catch (err: unknown) {
      setPermError(describeCameraError(err));
    }
  }, [deviceId, isRtsp, openSocket, sessionInfo, startRtspSession, startSending]);

  // Tear down: stop timers, camera/stream, the socket, and (RTSP) tell the
  // backend to stop the capture thread. Does NOT wait for a WS ack — callers
  // decide whether to persist-and-wait first (saveAndEnd) or not (stop).
  const teardown = useCallback(() => {
    stoppingRef.current = true;
    sessionIdRef.current = null;
    setAbsenteeOpen(false);
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
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
  }, []);

  const endRtspSession = useCallback(async (sessionId: string) => {
    const failures: string[] = [];

    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const stopResponse = await fetch(`${API_BASE}/v1/rtsp/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!stopResponse.ok && stopResponse.status !== 404) {
        failures.push(`camera stop failed (${stopResponse.status})`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "camera stop failed");
    }

    // Give the capture thread a brief opportunity to flush trailing telemetry.
    // The status endpoint is optional for compatibility with older deployments.
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const statusResponse = await fetch(`${API_BASE}/v1/rtsp/status/${sessionId}`, {
          headers: await authHeader(),
        });
        if (statusResponse.status === 404) {
          await new Promise((resolve) => window.setTimeout(resolve, 300));
          break;
        }
        if (!statusResponse.ok) {
          failures.push(`status check failed (${statusResponse.status})`);
          break;
        }
        const status = (await statusResponse.json()) as RtspStatusPayload;
        const stopped =
          status.running === false ||
          status.status === "stopped" ||
          status.status === "idle" ||
          status.status === "complete";
        if (stopped) break;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "status check failed");
    }

    // Closing the logical session is independent from stopping or observing the
    // camera runner. Always attempt it so one failed status request cannot strand
    // a session in progress.
    try {
      const endResponse = await fetch(`${API_BASE}/v1/sessions/${sessionId}/end`, {
        method: "POST",
        headers: await authHeader(),
      });
      if (!endResponse.ok) failures.push(`session close failed (${endResponse.status})`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "session close failed");
    }

    return {
      confirmed: failures.length === 0,
      warning: failures.length > 0 ? failures.join(" · ") : undefined,
    };
  }, []);

  // Unmount / abrupt stop: fire an end frame if the webcam socket is open, or
  // start the authenticated RTSP stop + session-close sequence, then release
  // local resources. No confirmation UI — that's the saveAndEnd path below.
  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (isRtsp && rtspSessionId) {
      void endRtspSession(rtspSessionId);
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "end", ts: (Date.now() - startEpochRef.current) / 1000 }));
      } catch {
        /* already closing */
      }
    }
    teardown();
    setRtspSessionId(null);
  }, [endRtspSession, isRtsp, rtspSessionId, teardown]);

  // Finish the active mode: for the webcam path, send the end frame and WAIT
  // for the server's session_ended ack (or a short timeout) before tearing down.
  // RTSP awaits its authenticated stop, flush check, and session-close requests.
  const saveAndEnd = useCallback(async () => {
    const totalRecorded = Math.max(
      sessionRosterRef.current.size,
      attended.size,
      presentRef.current.length,
    );
    const total = rosterHint.enrolled;
    const snapshot: Omit<SavedSummary, "confirmed" | "warning"> = {
      present: totalRecorded,
      total,
      candidates: sessionRosterRef.current.size,
      flags: proctorFlags.length,
      elapsed,
      engagement,
    };
    const finalize = (confirmed = true, warning?: string) => {
      teardown();
      setRtspSessionId(null);
      setSavedSummary({ ...snapshot, confirmed, warning });
    };

    if (isRtsp) {
      const sessionId = rtspSessionId ?? sessionIdRef.current;
      if (!sessionId) {
        finalize(false, "No persisted RTSP session was attached.");
        return;
      }
      const result = await endRtspSession(sessionId);
      finalize(result.confirmed, result.warning);
      return;
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      stoppingRef.current = true; // stop the reconnect loop while we close out
      endAckRef.current = () => finalize(true);
      try {
        ws.send(JSON.stringify({ type: "end", ts: (Date.now() - startEpochRef.current) / 1000 }));
      } catch {
        /* already closing */
      }
      // Fallback: if no ack arrives (socket already degraded), finalize
      // anyway — the live-written rows are already saved.
      window.setTimeout(() => {
        if (endAckRef.current) {
          endAckRef.current = null;
          finalize(false, "The server did not confirm the final session write.");
        }
      }, 3500);
    } else {
      finalize(false, "The inference connection was offline when the session ended.");
    }
  }, [
    attended.size,
    elapsed,
    endRtspSession,
    engagement,
    isRtsp,
    proctorFlags.length,
    rosterHint.enrolled,
    rtspSessionId,
    teardown,
  ]);

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

  const ModeIcon = isExamMode ? ShieldAlert : isWorkshopMode ? Presentation : Camera;
  const liveLabel = isExamMode
    ? "Proctoring live"
    : isWorkshopMode
      ? "Engagement live"
      : "Attendance live";
  const startLabel = isExamMode
    ? "Start exam monitoring"
    : isWorkshopMode
      ? "Start workshop engagement"
      : "Start session";
  const endLabel = isExamMode
    ? "End exam"
    : isWorkshopMode
      ? "End workshop"
      : "Save & end attendance";
  const disclosure = isExamMode
    ? "Frames are analysed in memory and are not stored. Every candidate event requires teacher review."
    : isWorkshopMode
      ? "Only anonymous class-level engagement aggregates are retained. No participant engagement scores are stored."
      : "This classroom uses camera-based attendance. Frames are processed in memory and never stored. Details from your teacher.";

  return (
    <div ref={wrapRef} className="app-bg relative flex h-screen w-screen flex-col overflow-hidden">
      {/* Absentee / Rotating QR Modal — anti-proxy rotating verification */}
      {isLectureMode && absenteeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm">
            <AbsenteeQR
              sessionId={sessionIdRef.current || rtspSessionId || `session-${sessionInfo.section}`}
              apiBase={API_BASE}
              onClose={() => setAbsenteeOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Top HUD */}
      <header className="relative z-30 flex h-20 shrink-0 items-center gap-6 border-b border-[color:var(--line)] bg-[color:var(--bg)]/85 px-8 backdrop-blur">
        <div className="flex items-baseline gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--line)]"
            style={{ background: "linear-gradient(135deg, var(--primary-deep), var(--primary))" }}
          >
            <ModeIcon className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                {sessionInfo.section} · {sessionInfo.title}
              </div>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 font-mono-nums text-[11px] uppercase tracking-[0.14em]",
                  sessionInfo.mode === "exam" && "bg-[color:var(--bad)]/15 text-[color:var(--bad)]",
                  sessionInfo.mode === "workshop" &&
                    "bg-[color:var(--accent)]/15 text-[color:var(--accent)]",
                  sessionInfo.mode === "lecture" &&
                    "bg-[color:var(--primary)]/15 text-[color:var(--primary)]",
                )}
              >
                {sessionInfo.mode}
              </span>
            </div>
            <div className="truncate font-mono-nums text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              {sessionInfo.room} · SensePro+
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4">
          {running && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5",
                isExamMode
                  ? "border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10"
                  : "border-[color:var(--accent)]/50 bg-[color:var(--accent)]/10",
              )}
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  isExamMode ? "bg-[color:var(--bad)]" : "bg-[color:var(--accent)]",
                )}
                style={{ animation: "sensepro-pulse 1.4s ease-in-out infinite" }}
              />
              <span
                className={cn(
                  "font-mono-nums text-xs uppercase tracking-[0.2em]",
                  isExamMode ? "text-[color:var(--bad)]" : "text-[color:var(--accent)]",
                )}
              >
                {liveLabel}
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
          {isLectureMode && (
            <button
              onClick={() => setAbsenteeOpen((v) => !v)}
              className={cn(
                "flex h-12 items-center gap-2 rounded-md border px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]",
                absenteeOpen
                  ? "border-[color:var(--primary)] bg-[color:var(--primary)]/20 text-[color:var(--primary)]"
                  : "border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--muted)] hover:text-[color:var(--ink)]",
              )}
              aria-label="Toggle Rotating Anti-Proxy QR"
              title="Open Anti-Proxy Rotating QR"
            >
              <QrCode className="h-5 w-5 text-[color:var(--primary)]" />
              <span className="hidden font-mono-nums text-xs uppercase tracking-wider text-[color:var(--primary)] font-semibold sm:inline">
                Rotating QR
              </span>
            </button>
          )}
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
                  src={`${API_BASE}/v1/rtsp/feed${feedToken ? `?token=${encodeURIComponent(feedToken)}` : ""}`}
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
                  {conn === "RECONNECTING" || wsAttempt <= 3 ? (
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
                        conn === "RECONNECTING" || wsAttempt <= 3
                          ? "text-[color:var(--warn)]"
                          : "text-[color:var(--bad)]",
                      )}
                    >
                      {conn === "RECONNECTING"
                        ? "Reconnecting to inference"
                        : wsAttempt <= 3
                          ? "Backend still starting up"
                          : "Inference socket unreachable"}
                    </div>
                    <div className="font-mono-nums text-[10px] tracking-wider text-[color:var(--muted)]">
                      {conn === "RECONNECTING"
                        ? isExamMode
                          ? "Candidate and event views show the last received state"
                          : isWorkshopMode
                            ? "Class signals show the last received aggregate state"
                            : "Roster shown below is the last verified state · session continues"
                        : wsAttempt <= 3
                          ? "Loading the vision model can take up to ~30s on a cold start · retrying"
                          : `${wsUrl} · check the backend is running · will keep retrying`}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Empty / permission states */}
            {!running && !permError && (
              <IdleState mode={sessionInfo.mode} cameraBlocked={cameraBlocked} />
            )}
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
          {/* Diagonal STALE ROSTER watermark — decorative background only, kept
              behind everything (z-0, pointer-events-none) so it never overlaps
              the KPI header or list below. The alert banner that used to share
              this absolute layer now renders as normal-flow content instead,
              which is what was causing it to visually collide with "Present
              now / Attended". */}
          {stale && running && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg, transparent 0 22px, rgba(251,191,36,0.06) 22px 24px)",
              }}
            >
              <div
                className="font-display text-4xl font-black uppercase tracking-[0.35em] text-[color:var(--warn)]/25"
                style={{ transform: "rotate(-24deg)" }}
              >
                {isExamMode
                  ? "Stale · Monitor"
                  : isWorkshopMode
                    ? "Stale · Signals"
                    : "Stale · Roster"}
              </div>
            </div>
          )}
          {stale && running && (
            <div className="relative z-10 mx-3 mt-3 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-3 py-2">
              <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--warn)]">
                {isExamMode
                  ? "Candidate view frozen · awaiting inference"
                  : isWorkshopMode
                    ? "Engagement telemetry frozen · awaiting inference"
                    : "Roster frozen · awaiting inference"}
              </div>
              <div className="mt-0.5 font-mono-nums text-[10px] text-[color:var(--muted)]">
                Last update{" "}
                {lastResultAtRef.current
                  ? `${Math.floor((performance.now() - lastResultAtRef.current) / 1000)}s ago`
                  : "—"}
              </div>
            </div>
          )}
          {isLectureMode && (
            <>
              <div className="relative z-10 flex items-center justify-between border-b border-[color:var(--line)] px-6 py-5">
                <div className="flex gap-5">
                  <div>
                    <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                      In View
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <div className="font-display text-3xl font-extrabold leading-none tracking-tight text-[color:var(--ink)]">
                        {present.length.toString().padStart(2, "0")}
                      </div>
                      <div className="font-mono-nums text-xs text-[color:var(--muted)]">
                        / {rosterHint.enrolled}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
                      Recorded
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <div className="font-display text-3xl font-extrabold leading-none tracking-tight text-[color:var(--accent)]">
                        {sessionRoster.length.toString().padStart(2, "0")}
                      </div>
                      <div className="font-mono-nums text-xs text-[color:var(--muted)]">
                        / {rosterHint.enrolled}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--ok)]">
                      Attended
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <div className="font-display text-3xl font-extrabold leading-none tracking-tight text-[color:var(--ok)]">
                        {attended.size.toString().padStart(2, "0")}
                      </div>
                      <div className="font-mono-nums text-xs text-[color:var(--muted)]">
                        / {rosterHint.enrolled}
                      </div>
                    </div>
                  </div>
                </div>
                {running && <span className="pulse-dot" />}
              </div>

              {/* Rotating Anti-Proxy QR action in the right rail */}
              <div className="relative z-10 flex items-center justify-between border-b border-[color:var(--line)] bg-[color:var(--surface-2)]/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-2 w-2 rounded-full bg-[color:var(--primary)] animate-pulse" />
                  <span className="font-mono-nums text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ink)]">
                    Rotating QR Check-in
                  </span>
                </div>
                <button
                  onClick={() => setAbsenteeOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border border-[color:var(--primary)]/60 bg-[color:var(--primary)] px-3 py-1 font-mono-nums text-[11px] font-bold uppercase tracking-wider text-white shadow-sm transition-all hover:bg-[color:var(--primary-deep)] active:scale-95"
                  title="Open Rotating Anti-Proxy QR Modal"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  <span>Open QR</span>
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {sessionRoster.length === 0 ? (
                  <div className="mx-3 mt-6 rounded-md border border-dashed border-[color:var(--line)] p-6 text-center">
                    <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                      Awaiting recognitions
                    </div>
                    <div className="mt-2 text-sm text-[color:var(--muted)]">
                      Once faces are matched they remain recorded here in real time throughout the
                      session.
                    </div>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-1">
                    <AnimatePresence initial={false}>
                      {sessionRoster
                        .slice()
                        .sort(
                          (a, b) =>
                            (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0) ||
                            b.last_seen_ts - a.last_seen_ts,
                        )
                        .map((p) => {
                          const isAttended = attended.has(p.student_id);
                          return (
                            <motion.li
                              key={p.student_id}
                              layout
                              initial={{ opacity: 0, x: 16 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: 16 }}
                              transition={{ duration: 0.2, ease: "easeOut" }}
                              className={cn(
                                "flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors",
                                p.isLive
                                  ? "border-[color:var(--line)] bg-[color:var(--surface-2)]/80"
                                  : "border-transparent opacity-85 hover:border-[color:var(--line)] hover:bg-[color:var(--surface-2)]/40",
                              )}
                            >
                              <div
                                className={cn(
                                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-md border font-mono-nums text-xs font-semibold",
                                  p.isLive
                                    ? "border-[color:var(--ok)]/50 text-[color:var(--ok)] ring-2 ring-[color:var(--ok)]/20"
                                    : "border-[color:var(--line)] text-[color:var(--ink)]",
                                )}
                                style={{
                                  background:
                                    "linear-gradient(135deg, var(--surface-2), var(--surface))",
                                }}
                              >
                                {initials(p.name)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[17px] font-medium text-[color:var(--ink)]">
                                  {p.name}
                                </div>
                                <div className="flex items-center gap-2 font-mono-nums text-[11px] text-[color:var(--muted)]">
                                  <span>{p.reg_no}</span>
                                  <span>·</span>
                                  <span>{tsAgo(p.first_seen_ts)}</span>
                                </div>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                {p.isLive ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--ok)]/15 px-2 py-0.5 font-mono-nums text-[9.5px] uppercase tracking-[0.14em] text-[color:var(--ok)] font-semibold">
                                    <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--ok)] animate-pulse" />
                                    In View
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded-full bg-[color:var(--surface-2)] px-2 py-0.5 font-mono-nums text-[9.5px] uppercase tracking-[0.14em] text-[color:var(--muted)]">
                                    Recorded
                                  </span>
                                )}
                                {isAttended && (
                                  <span className="font-mono-nums text-[9px] uppercase tracking-[0.15em] text-[color:var(--ok)] font-medium">
                                    ✓ Attended
                                  </span>
                                )}
                              </div>
                            </motion.li>
                          );
                        })}
                    </AnimatePresence>
                  </ul>
                )}
              </div>

              {/* Lecture keeps its existing class-level engagement summary. */}
              {engagement && (
                <div className="border-t border-[color:var(--line)] px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                      <Activity className="h-3.5 w-3.5" /> Class engagement
                    </div>
                    {!engagement.suppressed && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-mono-nums text-[11px] uppercase tracking-[0.16em]",
                          engagement.head_down > 0 || (engagement.phone ?? 0) > 0
                            ? "bg-[color:var(--warn)]/15 text-[color:var(--warn)]"
                            : "bg-[color:var(--ok)]/15 text-[color:var(--ok)]",
                        )}
                      >
                        {engagement.head_down > 0
                          ? "head-down"
                          : (engagement.phone ?? 0) > 0
                            ? "distracted"
                            : "attentive"}
                      </span>
                    )}
                  </div>
                  {engagement.suppressed ? (
                    <div className="mt-2 font-mono-nums text-[11px] leading-relaxed text-[color:var(--muted)]">
                      Hidden — engagement is class-aggregate only and needs ≥ {engagement.k_min}{" "}
                      visible {engagement.k_min === 1 ? "face" : "faces"} (privacy floor).
                    </div>
                  ) : (
                    <>
                      <div className="mt-3 flex items-baseline gap-2">
                        <div className="font-display text-2xl font-extrabold text-[color:var(--ink)]">
                          {engagement.vnei == null ? "—" : `${Math.round(engagement.vnei * 100)}%`}
                        </div>
                        <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
                          attention (class)
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-nums text-[11px]">
                        <span className="text-[color:var(--ok)]">
                          {engagement.attending} attending
                        </span>
                        <span
                          className={
                            engagement.head_down > 0
                              ? "text-[color:var(--warn)]"
                              : "text-[color:var(--muted)]"
                          }
                        >
                          {engagement.head_down} head-down
                        </span>
                        <span
                          className={
                            (engagement.phone ?? 0) > 0
                              ? "text-[color:var(--warn)]"
                              : "text-[color:var(--muted)]"
                          }
                        >
                          {engagement.phone ?? 0} on phone
                        </span>
                        <span className="text-[color:var(--muted)]">
                          {engagement.visible} visible
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {isExamMode && (
            <ExamCaptureRail
              candidates={sessionRoster}
              flags={proctorFlags}
              inFrame={present.length}
              proctor={proctorLive}
              rosterTotal={rosterHint.enrolled}
              running={running}
              telemetrySeen={examMode}
              rtspStatus={rtspStatus}
              rtspError={rtspStatusError}
            />
          )}
          {isWorkshopMode && (
            <WorkshopCaptureRail
              engagement={engagement}
              fallbackVisible={present.length}
              running={running}
              rtspStatus={rtspStatus}
              rtspError={rtspStatusError}
            />
          )}
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
                  max={2560}
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
        {disclosure}
      </div>

      {/* Bottom bar */}
      <footer className="flex h-24 shrink-0 items-center justify-between border-t border-[color:var(--line)] bg-[color:var(--bg)]/85 px-8 backdrop-blur">
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
          {running
            ? isExamMode
              ? "Exam monitoring in progress"
              : isWorkshopMode
                ? "Workshop engagement in progress"
                : "Session in progress"
            : "Session idle"}
        </div>
        <div className="flex items-center gap-3">
          {!running ? (
            <button
              onClick={start}
              className="flex h-14 items-center gap-3 rounded-md bg-[color:var(--primary)] px-8 text-base font-semibold tracking-wide text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
            >
              <Play className="h-5 w-5" fill="currentColor" />
              {startLabel}
            </button>
          ) : (
            <button
              onClick={() => void saveAndEnd()}
              className={cn(
                "flex h-14 items-center gap-3 rounded-md px-8 text-base font-semibold tracking-wide text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2",
                isExamMode
                  ? "bg-[color:var(--bad)] focus-visible:ring-[color:var(--bad)]"
                  : isWorkshopMode
                    ? "bg-[color:var(--accent)] focus-visible:ring-[color:var(--accent)]"
                    : "bg-[color:var(--ok)] focus-visible:ring-[color:var(--ok)]",
              )}
            >
              {isExamMode ? (
                <ShieldAlert className="h-5 w-5" />
              ) : isWorkshopMode ? (
                <Presentation className="h-5 w-5" />
              ) : (
                <Save className="h-5 w-5" />
              )}
              {endLabel}
            </button>
          )}
        </div>
      </footer>

      {/* Mode-specific summary after the server close sequence completes. */}
      <AnimatePresence>
        {savedSummary && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="glass-panel w-[min(92vw,460px)] p-8 text-center"
            >
              <div
                className={cn(
                  "mx-auto flex h-16 w-16 items-center justify-center rounded-full border",
                  savedSummary.confirmed
                    ? "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10"
                    : "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10",
                )}
              >
                {savedSummary.confirmed ? (
                  <CheckCircle2 className="h-8 w-8 text-[color:var(--ok)]" />
                ) : (
                  <X className="h-8 w-8 text-[color:var(--warn)]" />
                )}
              </div>
              <div className="mt-5 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
                {!savedSummary.confirmed
                  ? "Server confirmation pending"
                  : isExamMode
                    ? "Exam session closed"
                    : isWorkshopMode
                      ? "Workshop session closed"
                      : "Attendance saved"}
              </div>
              <div className="mt-2 text-sm text-[color:var(--muted)]">
                {sessionInfo.section} · {sessionInfo.title} ·{" "}
                {formatSessionDuration(savedSummary.elapsed)}
              </div>
              {isExamMode ? (
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <SummaryMetric label="Candidates observed" value={savedSummary.candidates} />
                  <SummaryMetric label="Review events" value={savedSummary.flags} />
                </div>
              ) : isWorkshopMode ? (
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <SummaryMetric
                    label="Class VNEI"
                    value={
                      savedSummary.engagement?.vnei == null
                        ? "Withheld"
                        : `${Math.round(savedSummary.engagement.vnei * 100)}%`
                    }
                  />
                  <SummaryMetric
                    label="Visible at close"
                    value={savedSummary.engagement?.visible ?? 0}
                  />
                </div>
              ) : (
                <div className="mt-6 flex items-baseline justify-center gap-2">
                  <span className="font-display text-5xl font-extrabold text-[color:var(--ok)]">
                    {savedSummary.present}
                  </span>
                  <span className="font-mono-nums text-lg text-[color:var(--muted)]">
                    / {savedSummary.total} present
                  </span>
                </div>
              )}
              <p className="mt-4 font-mono-nums text-[11px] leading-relaxed tracking-wide text-[color:var(--muted)]">
                {savedSummary.warning
                  ? savedSummary.warning
                  : isExamMode
                    ? "Candidate events are available in the teacher review queue. No event is an automatic verdict."
                    : isWorkshopMode
                      ? savedSummary.engagement?.suppressed
                        ? "No class engagement value was retained because the privacy threshold was not met."
                        : "Workshop session closed. Session history remains the source of truth for retained aggregate windows."
                      : "Records written to the session history. Absent students are everyone not marked present."}
              </p>
              <div className="mt-7 flex items-center justify-center gap-3">
                <a
                  href="/sessions"
                  className="flex h-12 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-5 text-sm font-semibold text-[color:var(--ink)] transition-colors hover:bg-[color:var(--surface)]"
                >
                  View sessions
                </a>
                <button
                  onClick={() => setSavedSummary(null)}
                  className="flex h-12 items-center gap-2 rounded-md bg-[color:var(--primary)] px-6 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)]"
                >
                  <Play className="h-4 w-4" fill="currentColor" />
                  New session
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function proctorEventLabel(type: string): string {
  if (type === "phone") return "Handheld device visible";
  if (type === "extra_person") return "Additional person in frame";
  if (type === "head_pose") return "Sustained off-screen head pose";
  return "Candidate event";
}

function ExamCaptureRail({
  candidates,
  flags,
  inFrame,
  proctor,
  rosterTotal,
  running,
  telemetrySeen,
  rtspStatus,
  rtspError,
}: {
  candidates: SessionRosterEntry[];
  flags: ProctorAlert[];
  inFrame: number;
  proctor: ProctorLiveState;
  rosterTotal: number;
  running: boolean;
  telemetrySeen: boolean;
  rtspStatus: string | null;
  rtspError: string | null;
}) {
  const phoneEvents = flags.filter((flag) => flag.type === "phone").length;
  const personEvents = flags.filter((flag) => flag.type === "extra_person").length;
  const poseEvents = flags.filter((flag) => flag.type === "head_pose").length;
  const unavailable = proctor.ready === false;
  const statusLabel = unavailable
    ? "Proctor unavailable"
    : proctor.phone
      ? "Device visible"
      : running && (telemetrySeen || proctor.ready === true)
        ? "Monitoring"
        : running
          ? "Waiting for telemetry"
          : "Ready to start";

  return (
    <>
      <div className="relative z-10 border-b border-[color:var(--line)] px-5 py-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            <ShieldAlert className="h-4 w-4 text-[color:var(--bad)]" /> Exam monitor
          </div>
          {running && <span className="pulse-dot" />}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <RailMetric label="In frame" value={inFrame} suffix={`/ ${rosterTotal}`} />
          <RailMetric label="Observed" value={candidates.length} />
          <RailMetric
            label="Review events"
            value={flags.length}
            tone={flags.length ? "bad" : "muted"}
          />
        </div>
      </div>

      <div
        className={cn(
          "relative z-10 border-b border-[color:var(--line)] px-5 py-4",
          unavailable
            ? "bg-[color:var(--bad)]/10"
            : proctor.phone
              ? "bg-[color:var(--bad)]/10"
              : "bg-[color:var(--surface-2)]/45",
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn(
              "font-mono-nums text-[11px] font-semibold uppercase tracking-[0.18em]",
              unavailable || proctor.phone
                ? "text-[color:var(--bad)]"
                : running
                  ? "text-[color:var(--ok)]"
                  : "text-[color:var(--muted)]",
            )}
          >
            {statusLabel}
          </span>
          <span className="font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
            {proctor.backend ?? rtspStatus ?? "proctor"}
          </span>
        </div>
        {unavailable ? (
          <p className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]">
            The proctor detector did not initialise. Camera identity can continue, but no exam event
            will be treated as monitored until the backend is ready.
          </p>
        ) : proctor.phone ? (
          <p className="mt-2 text-xs text-[color:var(--ink)]">
            Handheld device visible{proctor.phoneOwner ? ` · ${proctor.phoneOwner}` : ""}
          </p>
        ) : proctor.poses.length > 0 ? (
          <p className="mt-2 text-xs text-[color:var(--muted)]">
            Head-pose telemetry active for {proctor.poses.length} visible candidate
            {proctor.poses.length === 1 ? "" : "s"}.
          </p>
        ) : null}
        {rtspError && <p className="mt-2 text-xs text-[color:var(--warn)]">{rtspError}</p>}
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-3 gap-2">
          <EventCount icon={Smartphone} label="Device" value={phoneEvents} />
          <EventCount icon={UsersRound} label="Additional" value={personEvents} />
          <EventCount icon={Eye} label="Head pose" value={poseEvents} />
        </div>

        <div className="mt-5">
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Event timeline
          </div>
          {flags.length === 0 ? (
            <div className="mt-2 rounded-md border border-dashed border-[color:var(--line)] px-3 py-5 text-center text-xs text-[color:var(--muted)]">
              No candidate events have been sent for review.
            </div>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {flags.slice(0, 12).map((flag) => (
                <li
                  key={flag.id}
                  className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/60 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[color:var(--ink)]">
                        {proctorEventLabel(flag.type)}
                      </div>
                      <div className="mt-0.5 truncate font-mono-nums text-[10px] text-[color:var(--muted)]">
                        {flag.name ?? "Unattributed candidate"}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono-nums text-[10px] text-[color:var(--muted)]">
                      {tsAgo(flag.ts)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5">
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Candidates observed
          </div>
          {candidates.length === 0 ? (
            <p className="mt-2 text-xs text-[color:var(--muted)]">No candidates identified yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {candidates
                .slice()
                .sort(
                  (a, b) => Number(b.isLive) - Number(a.isLive) || b.last_seen_ts - a.last_seen_ts,
                )
                .map((candidate) => (
                  <li
                    key={candidate.student_id}
                    className="flex items-center gap-3 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/45 px-3 py-2.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[color:var(--line)] font-mono-nums text-[10px] text-[color:var(--ink)]">
                      {initials(candidate.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[color:var(--ink)]">
                        {candidate.name}
                      </div>
                      <div className="font-mono-nums text-[10px] text-[color:var(--muted)]">
                        {candidate.reg_no}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "font-mono-nums text-[9px] uppercase tracking-[0.14em]",
                        candidate.isLive ? "text-[color:var(--ok)]" : "text-[color:var(--muted)]",
                      )}
                    >
                      {candidate.isLive ? "In frame" : `Last seen ${tsAgo(candidate.last_seen_ts)}`}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function WorkshopCaptureRail({
  engagement,
  fallbackVisible,
  running,
  rtspStatus,
  rtspError,
}: {
  engagement: WsEngagement | null;
  fallbackVisible: number;
  running: boolean;
  rtspStatus: string | null;
  rtspError: string | null;
}) {
  const visible = engagement?.visible ?? fallbackVisible;
  const observable =
    engagement?.observable ??
    (engagement ? Math.min(engagement.visible, engagement.attending + engagement.head_down) : 0);
  const kMin = engagement?.k_min ?? 5;
  const waitingForPose = engagement?.suppression_reason === "insufficient_pose_observations";
  const phoneDetector = engagement?.phone_detector;
  const thresholdObserved = waitingForPose ? observable : visible;
  const thresholdProgress = Math.min(100, (thresholdObserved / Math.max(kMin, 1)) * 100);
  const vnei = engagement?.vnei == null ? null : Math.round(engagement.vnei * 100);
  const reportable = !!engagement && !engagement.suppressed && vnei !== null;
  const windowStatus = engagement?.window;
  const windowSeconds = windowStatus?.window_s ?? engagement?.window_s;
  const completedWindows = windowStatus?.completed_windows;
  const lastWindowState = windowStatus?.last_window?.state;
  const persisted = engagement?.persisted;
  const windowReport =
    typeof completedWindows === "number"
      ? completedWindows === 0
        ? windowStatus?.state === "collecting"
          ? "Collecting first window"
          : "No closed windows"
        : lastWindowState === "withheld"
          ? `${completedWindows} closed · latest withheld`
          : `${completedWindows} window${completedWindows === 1 ? "" : "s"} reported`
      : typeof persisted === "number"
        ? `${persisted} window${persisted === 1 ? "" : "s"} reported`
        : persisted === true
          ? "Latest window reported"
          : persisted === false
            ? "Collecting current window"
            : "Awaiting telemetry";

  return (
    <>
      <div className="relative z-10 border-b border-[color:var(--line)] px-5 py-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            <Presentation className="h-4 w-4 text-[color:var(--accent)]" /> Workshop engagement
          </div>
          {running && <span className="pulse-dot" />}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <RailMetric label="Visible" value={visible} />
          <RailMetric label="Observable" value={observable} />
          <RailMetric
            label="Class VNEI"
            value={vnei ?? "—"}
            suffix={vnei === null ? undefined : "%"}
            tone="accent"
          />
        </div>
      </div>

      <div className="relative z-10 border-b border-[color:var(--line)] bg-[color:var(--surface-2)]/45 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Reportability threshold
          </span>
          <span className="font-mono-nums text-xs text-[color:var(--ink)]">
            {Math.min(thresholdObserved, kMin)} / {kMin} {waitingForPose ? "observable" : "visible"}
          </span>
        </div>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-[color:var(--surface)]"
          role="progressbar"
          aria-label={`${waitingForPose ? "Pose-observable" : "Visible"} participants required for a class aggregate`}
          aria-valuemin={0}
          aria-valuemax={kMin}
          aria-valuenow={Math.min(thresholdObserved, kMin)}
        >
          <div
            className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-200"
            style={{ width: `${thresholdProgress}%` }}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]" aria-live="polite">
          {!running
            ? "Start the workshop to begin class-level measurement."
            : reportable
              ? "The current class aggregate is reportable. No participant-level engagement score is retained."
              : waitingForPose
                ? `The privacy floor is met, but engagement is withheld until ${kMin} visible faces have usable pose observations. ${observable} of ${kMin} currently observable.`
                : `Class engagement is withheld until ${kMin} participants are visible together. ${visible} of ${kMin} currently visible.`}
        </p>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-2 gap-2">
          <SignalCard icon={Eye} label="Head down" value={engagement?.head_down ?? "—"} />
          <SignalCard icon={Smartphone} label="Device signal" value={engagement?.phone ?? "—"} />
          <SignalCard icon={Move} label="Still" value={engagement?.still ?? "—"} />
          <SignalCard icon={Activity} label="Moving" value={engagement?.moving ?? "—"} />
        </div>

        {running && phoneDetector && (!phoneDetector.ready || !phoneDetector.production) && (
          <div className="mt-3 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-3 py-2 text-xs leading-relaxed text-[color:var(--warn)]">
            {!phoneDetector.ready
              ? "Device observation is unavailable; posture and movement aggregation continues."
              : `Device observation is using ${phoneDetector.backend ?? "a test detector"}. Configure the production YOLO backend before a live workshop.`}
          </div>
        )}

        <div className="mt-4 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/45 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              Aggregate window
            </span>
            <span className="font-mono-nums text-[10px] text-[color:var(--ink)]">
              {windowSeconds
                ? `${windowSeconds}s${windowStatus?.state ? ` · ${windowStatus.state}` : ""}`
                : "Waiting"}
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs">
            <span className="text-[color:var(--muted)]">Window reporting</span>
            <span
              className={
                lastWindowState === "reported" || (lastWindowState == null && reportable)
                  ? "text-[color:var(--ok)]"
                  : "text-[color:var(--muted)]"
              }
            >
              {windowReport}
            </span>
          </div>
          {(rtspStatus || rtspError) && (
            <div className="mt-3 border-t border-[color:var(--line)] pt-3 font-mono-nums text-[10px] text-[color:var(--muted)]">
              {rtspError ? `Status unavailable · ${rtspError}` : `RTSP · ${rtspStatus}`}
            </div>
          )}
        </div>

        <p className="mt-4 font-mono-nums text-[10px] leading-relaxed text-[color:var(--muted)]">
          Signals are counted only at class level. Names and individual engagement values are not
          shown or stored in this workspace.
        </p>
      </div>
    </>
  );
}

function RailMetric({
  label,
  value,
  suffix,
  tone = "muted",
}: {
  label: string;
  value: string | number;
  suffix?: string;
  tone?: "muted" | "accent" | "bad";
}) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono-nums text-[9px] uppercase tracking-[0.14em] text-[color:var(--muted)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 flex items-baseline gap-1 font-display text-2xl font-extrabold leading-none",
          tone === "bad"
            ? "text-[color:var(--bad)]"
            : tone === "accent"
              ? "text-[color:var(--accent)]"
              : "text-[color:var(--ink)]",
        )}
      >
        {typeof value === "number" ? value.toString().padStart(2, "0") : value}
        {suffix && (
          <span className="font-mono-nums text-[10px] text-[color:var(--muted)]">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function EventCount({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/45 p-3">
      <Icon
        className={cn("h-4 w-4", value ? "text-[color:var(--bad)]" : "text-[color:var(--muted)]")}
      />
      <div className="mt-2 font-display text-xl font-extrabold text-[color:var(--ink)]">
        {value}
      </div>
      <div className="mt-0.5 truncate font-mono-nums text-[9px] uppercase tracking-wider text-[color:var(--muted)]">
        {label}
      </div>
    </div>
  );
}

function SignalCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/45 p-4">
      <div className="flex items-center justify-between gap-3">
        <Icon className="h-4 w-4 text-[color:var(--accent)]" />
        <span className="font-display text-2xl font-extrabold text-[color:var(--ink)]">
          {value}
        </span>
      </div>
      <div className="mt-2 font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]">
        {label}
      </div>
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/60 p-4">
      <div className="font-display text-3xl font-extrabold text-[color:var(--ink)]">{value}</div>
      <div className="mt-1 font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]">
        {label}
      </div>
    </div>
  );
}

function IdleState({ mode, cameraBlocked }: { mode: SessionMode; cameraBlocked: string | null }) {
  const Icon = mode === "exam" ? ShieldAlert : mode === "workshop" ? Presentation : Camera;
  const title =
    mode === "exam"
      ? "Exam monitoring ready"
      : mode === "workshop"
        ? "Workshop engagement ready"
        : "Kiosk standby";
  const action =
    mode === "exam"
      ? "Start exam monitoring"
      : mode === "workshop"
        ? "Start workshop engagement"
        : "Start session";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-black/40 via-black/20 to-black/40">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--line)]"
        style={{ background: "linear-gradient(135deg, var(--surface-2), var(--surface))" }}
      >
        <Icon className="h-7 w-7 text-[color:var(--muted)]" />
      </div>
      <div className="font-display text-3xl font-extrabold tracking-tight text-[color:var(--ink)]">
        {title}
      </div>
      {/* Say the camera can't open HERE, before the operator presses Start and
          waits on a session that can never begin. */}
      {cameraBlocked ? (
        <div className="mx-6 max-w-lg rounded-md border border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 px-4 py-3 text-center">
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--bad)]">
            Camera blocked at this address
          </div>
          <p className="mt-1.5 text-sm text-[color:var(--ink)]">{cameraBlocked}</p>
        </div>
      ) : (
        <div className="max-w-md text-center text-sm text-[color:var(--muted)]">
          Press <span className="font-mono-nums text-[color:var(--ink)]">{action}</span> to open the
          camera and connect the inference service.
        </div>
      )}
      {/* Mode came from the URL (the /start wizard) or defaulted to lecture if
          /capture was opened directly — make that explicit and give a way
          back to pick a different one before the session actually starts. */}
      <div className="flex items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface)]/60 px-3 py-1.5 text-xs">
        <span className="text-[color:var(--muted)]">Mode:</span>
        <span className="font-mono-nums uppercase tracking-[0.14em] text-[color:var(--ink)]">
          {mode}
        </span>
        <span className="text-[color:var(--line)]">·</span>
        <a href="/start" className="text-[color:var(--primary)] hover:underline">
          Change
        </a>
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

function formatSessionDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.max(0, totalSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
