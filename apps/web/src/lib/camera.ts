/**
 * Camera preflight + error translation for the capture kiosk.
 *
 * Why this exists: `navigator.mediaDevices` only exists in a SECURE CONTEXT.
 * `http://localhost` and `http://127.0.0.1` count as secure; a plain LAN origin
 * like `http://192.168.1.19:5173` does NOT. Vite runs with `host: true` (so the
 * phone can reach the QR claim page), which means it advertises exactly that
 * LAN URL in the terminal — open the app there and `navigator.mediaDevices` is
 * `undefined`, so capture.tsx's `start()` died on its first line with
 * "Cannot read properties of undefined (reading 'getUserMedia')" while the API
 * and the inference socket both still connected fine. The page looked healthy
 * and the session simply never started.
 *
 * So: detect that up front, say precisely what to do about it, and translate
 * the browser's DOMException names into something an operator can act on.
 */

/** Human-readable reason the camera cannot work here, or null if it can. */
export function cameraBlockReason(): string | null {
  if (typeof window === "undefined") return null;

  const secure = window.isSecureContext;
  const hasApi = typeof navigator !== "undefined" && !!navigator.mediaDevices;
  if (secure && hasApi) return null;

  if (!secure) {
    const { hostname, port, pathname, search } = window.location;
    const localUrl = `http://localhost${port ? `:${port}` : ""}${pathname}${search}`;
    return (
      `Browsers only allow camera access on a secure origin, and this page is open ` +
      `on "${hostname}" over plain http. Open ${localUrl} on this machine instead, ` +
      `or serve the app over https (the tunnel URL used for the phone QR demo works too).`
    );
  }

  return (
    "This browser does not expose navigator.mediaDevices, so the camera cannot be " +
    "opened. Use a current Chrome, Edge, or Firefox — and not a private/embedded webview."
  );
}

/** True when a live camera can be opened at this origin. */
export function cameraAvailable(): boolean {
  return cameraBlockReason() === null;
}

/**
 * Turn a getUserMedia rejection into something actionable. The raw DOMException
 * names ("NotAllowedError", "OverconstrainedError") mean nothing to an operator
 * standing at a classroom kiosk.
 */
export function describeCameraError(err: unknown): string {
  const blocked = cameraBlockReason();
  if (blocked) return blocked;

  const name =
    typeof err === "object" && err !== null ? (err as { name?: string }).name : undefined;
  const raw = err instanceof Error ? err.message : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Camera permission was denied for this site. Click the camera icon in the " +
        "address bar, allow access, then retry."
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera is attached. Plug in the board's USB camera and retry.";
    case "NotReadableError":
    case "TrackStartError":
      return (
        "The camera is already in use by another app (Zoom, Teams, OBS, or another " +
        "browser tab). Close it and retry."
      );
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return (
        "The selected camera is no longer available — it may have been unplugged. " +
        "Pick a different camera in Settings, then retry."
      );
    case "AbortError":
      return "The camera failed to start. Retry, or replug the USB camera.";
    default:
      return raw || "Camera unavailable.";
  }
}
