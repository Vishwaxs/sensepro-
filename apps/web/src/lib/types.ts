/** Contract types. The WS shapes mirror backend/app/ws.py + vision/pipeline.py
 *  exactly; the REST shapes anticipate packages/contracts/openapi.yaml. */

export type Role = "teacher" | "management" | "admin" | "student";

export type PresenceState = "PRESENT" | "UNVERIFIED" | "ABSENT";

export interface Student {
  student_id: string;
  name: string;
  class_section: string;
  consent_signed: boolean;
}

export interface Session {
  session_id: string;
  class_section: string;
  subject: string;
  mode: "attendance" | "exam";
  started_at: string;
  ended_at: string | null;
}

export interface PresenceInterval {
  student_id: string;
  state: PresenceState;
  started_at: number;
  ended_at: number | null;
}

export interface RosterEntry {
  student_id: string;
  name: string;
  state: PresenceState;
  last_seen_ts: number | null;
  present_seconds: number;
}

/* ---------------- WebSocket contract (backend/app/ws.py) ---------------- */

/** client -> server */
export interface FrameMessage {
  type: "frame";
  ts: number; // seconds since session start
  jpg_b64: string;
}
export interface EndMessage {
  type: "end";
  ts: number;
}
export type ClientMessage = FrameMessage | EndMessage;

/** server -> client */
export interface Face {
  track_id: number;
  /** [x1, y1, x2, y2] in SENT-frame pixels */
  box: [number, number, number, number];
  student_id: string | null;
  score: number;
}
export interface ResultMessage {
  type: "result";
  ts: number;
  faces: Face[];
  transitions: { student_id: string; state: PresenceState }[];
  present: string[];
}
export interface ErrorMessage {
  type: "error";
  detail: string;
}
export interface SessionEndedMessage {
  type: "session_ended";
  ts: number;
}
export type ServerMessage = ResultMessage | ErrorMessage | SessionEndedMessage;

/* ---------------- Aggregate-only engagement (invariant: no per-student) --- */

export interface ZoneAggregate {
  zone: "front" | "middle" | "back";
  /** naive mean visibility-weighted engagement (biased toward the front) */
  naive_mean: number;
  /** Visibility-Normalised Engagement Index */
  vnei: number;
  /** students the camera can actually see in this zone */
  n_visible: number;
  /** k >= 5 suppression flag — suppressed zones render no numbers */
  suppressed: boolean;
}

export interface CaptureClient {
  device_id: string;
  label: string;
  room: string;
  last_seen: string;
  status: "online" | "offline";
}

export interface ConsentRecord {
  student_id: string;
  name: string;
  signed: boolean;
  signed_on: string | null;
}

export interface AuditEntry {
  seq: number;
  action: string;
  actor: string;
  at: string;
  hash: string;
}
