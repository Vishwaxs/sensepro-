/** OAuth landing page (`/auth/callback`).
 *
 *  Google redirects here with `?code=...`, which supabase-js exchanges for a
 *  session in the background (detectSessionInUrl, on by default). That exchange
 *  is asynchronous, which is exactly why this route exists instead of sending
 *  the provider straight back to a guarded page: guardRoute's beforeLoad calls
 *  getSession() immediately, would find nothing yet, and would bounce a user
 *  who HAS just authenticated back to /login — an intermittent failure that
 *  depends on which finishes first.
 *
 *  So this page owns the wait. It is unguarded, resolves the session, and only
 *  then routes onward: to whatever the user was originally reaching for, or to
 *  their role's home, or to /no-role when an admin has not assigned a role yet.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabaseAuth } from "@/lib/supabase/client";
import { homeForRole, POST_AUTH_REDIRECT_KEY } from "@/lib/auth-guard";
import type { AppRole } from "@/lib/auth-guard";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/callback")({
  head: () => ({ meta: [{ title: "Signing in · SensePro+" }] }),
  component: AuthCallbackPage,
});

/** Read app_role out of the signed JWT — the same single source of truth the
 *  route guard uses, so the landing page can never disagree with the gate. */
function roleFromToken(accessToken: string | undefined): AppRole | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const claims = JSON.parse(atob(padded));
    return (claims.app_role as AppRole) ?? null;
  } catch {
    return null;
  }
}

function AuthCallbackPage() {
  const nav = useNavigate();
  const [message, setMessage] = useState("Completing sign-in…");
  // React 18 StrictMode mounts effects twice in dev; without this the redirect
  // would fire twice and the second navigation could clobber the first.
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    let cancelled = false;

    function finish(session: { access_token?: string } | null) {
      if (cancelled || done.current) return;
      done.current = true;

      if (!session) {
        setMessage("Sign-in did not complete.");
        toast.error("Google sign-in did not complete. Please try again.");
        nav({ to: "/login" });
        return;
      }

      const stored = sessionStorage.getItem(POST_AUTH_REDIRECT_KEY);
      sessionStorage.removeItem(POST_AUTH_REDIRECT_KEY);

      const role = roleFromToken(session.access_token);
      // Only same-site absolute paths, mirroring login.tsx's validateSearch —
      // this value came out of storage, so it is re-checked rather than trusted.
      const safeStored =
        stored && stored.startsWith("/") && !stored.startsWith("//") ? stored : null;
      const target = safeStored ?? homeForRole(role);

      toast.success(role ? "Signed in with Google." : "Signed in.");
      nav({ to: target });
    }

    // Two paths to a session, because the code exchange may finish before or
    // after this effect runs, and only listening would hang if it already had.
    const { data: sub } = supabaseAuth.auth.onAuthStateChange((_event, session) => {
      if (session) finish(session);
    });

    supabaseAuth.auth.getSession().then(({ data }) => {
      if (data.session) finish(data.session);
    });

    // Backstop: if neither fires, the provider returned an error (or the user
    // opened this URL directly). Say so instead of spinning forever.
    const timeout = window.setTimeout(() => {
      if (!done.current) {
        const params = new URLSearchParams(window.location.search);
        const err = params.get("error_description") || params.get("error");
        if (err) toast.error(decodeURIComponent(err));
        finish(null);
      }
    }, 8000);

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      window.clearTimeout(timeout);
    };
  }, [nav]);

  return (
    <div className="app-bg grain-overlay flex min-h-screen items-center justify-center px-6">
      <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-[color:var(--line)]"
          style={{ borderTopColor: "var(--primary)" }}
          aria-hidden
        />
        <p className="font-mono-nums text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          {message}
        </p>
      </div>
    </div>
  );
}
