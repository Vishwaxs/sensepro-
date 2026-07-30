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
