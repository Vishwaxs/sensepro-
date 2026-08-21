import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Command, Fingerprint } from "lucide-react";
import { AuthenticateWithRedirectCallback, SignIn, SignUp, useUser } from "@clerk/clerk-react";
import { GlowBorder, ClickSpark, ThemeToggle, Lightfall } from "@/components/fx";
import { useTheme } from "@/lib/theme";
import { homeForRole } from "@/lib/auth-guard";
import type { AppRole } from "@/lib/auth-guard";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => {
    const r = s.redirect;
    return typeof r === "string" && r.startsWith("/") && !r.startsWith("//") ? { redirect: r } : {};
  },
  head: () => ({
    meta: [{ title: "Sign in · SensePro+" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const { redirect: returnTo } = Route.useSearch();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const { isSignedIn, isLoaded, user } = useUser();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [isSsoCallback, setIsSsoCallback] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isCallback =
        window.location.hash.includes("sso-callback") ||
        window.location.search.includes("sso-callback") ||
        window.location.pathname.includes("sso-callback");
      if (isCallback) {
        setIsSsoCallback(true);
      }
      if (window.location.hash.includes("sign_up") || window.location.hash.includes("sign-up")) {
        setMode("signup");
      }
    }
  }, []);

  useEffect(() => {
    if (isLoaded && isSignedIn && user) {
      const role = ((user.publicMetadata?.role as AppRole) ||
        (user.unsafeMetadata?.role as AppRole) ||
        "teacher") as AppRole;
      const target = returnTo || homeForRole(role) || "/teacher";
      nav({ to: target });
    }
  }, [isLoaded, isSignedIn, user, returnTo, nav]);

  // If completing OAuth SSO callback
  if (isSsoCallback) {
    return (
      <div className="app-bg grain-overlay relative flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[color:var(--primary)] border-t-transparent" />
          <span className="font-mono-nums text-xs uppercase tracking-widest text-[color:var(--muted)]">
            Completing authentication...
          </span>
          <div className="opacity-0 h-0 overflow-hidden pointer-events-none">
            <AuthenticateWithRedirectCallback
              signInFallbackRedirectUrl={returnTo || "/teacher"}
              signUpFallbackRedirectUrl={returnTo || "/teacher"}
            />
          </div>
        </div>
      </div>
    );
  }

  // If already signed in and redirecting, render a clean loading spinner instead of the login box
  if (isLoaded && isSignedIn) {
    return (
      <div className="app-bg grain-overlay relative flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[color:var(--primary)] border-t-transparent" />
          <span className="font-mono-nums text-xs uppercase tracking-widest text-[color:var(--muted)]">
            Authenticating...
          </span>
        </div>
      </div>
    );
  }

  // Where to land after auth completes (OAuth or password)
  const afterAuthUrl = returnTo || "/teacher";

  return (
    <ClickSpark sparkColor="#F59E0B" sparkCount={8} sparkRadius={18}>
      <div className="app-bg grain-overlay relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
        {/* Theme Toggle */}
        <div className="absolute top-6 right-6 z-50">
          <ThemeToggle className="bg-transparent border-transparent hover:bg-[color:var(--surface-2)] hover:border-[color:var(--line)]" />
        </div>

        {/* Ambient */}
        <div className="absolute inset-0 -z-30">
          <Lightfall
            dpr={1}
            colors={
              isDark
                ? ["#F59E0B", "#D97706", "#10B981"]
                : ["#D97706", "#EA580C", "#B45309", "#059669", "#0D9488"]
            }
            backgroundColor={isDark ? "#07070A" : "#000000"}
            speed={0.3}
            streakCount={2}
            streakWidth={isDark ? 0.6 : 0.9}
            streakLength={1}
            glow={isDark ? 0.6 : 1.2}
            density={0.4}
            twinkle={0.5}
            zoom={3}
            backgroundGlow={isDark ? 0.2 : 0.0}
            opacity={isDark ? 0.45 : 0.45}
            mouseInteraction={true}
            mouseStrength={isDark ? 0.3 : 0.3}
            mouseRadius={0.7}
          />
        </div>

        {/* Decorative grid lines */}
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
          <div className="absolute top-1/4 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[color:var(--line)] to-transparent" />
          <div className="absolute top-3/4 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[color:var(--line)] to-transparent" />
          <div className="absolute left-1/4 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-[color:var(--line)] to-transparent" />
          <div className="absolute left-3/4 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-[color:var(--line)] to-transparent" />
        </div>

        {/* Login card */}
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 w-full max-w-md"
        >
          <GlowBorder className="w-full" color="var(--primary, #F59E0B)" duration={5} radius="20px">
            <div className="glass-frosted glass-hover rounded-[20px] p-6 sm:p-8 flex flex-col items-center">
              {/* Logo */}
              <div className="flex items-center gap-3 w-full mb-6">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-lg animate-pulse-ring shrink-0"
                  style={{
                    background: "linear-gradient(135deg, var(--primary-deep), var(--primary))",
                  }}
                >
                  <Command className="h-5 w-5 text-[#07070A]" />
                </div>
                <div>
                  <div className="font-display text-xl font-extrabold tracking-tight">
                    SensePro<span className="text-gradient">+</span>
                  </div>
                  <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                    Console · Access
                  </div>
                </div>
              </div>

              {/* Clerk Sign In / Sign Up Component */}
              <div className="w-full flex justify-center">
                {mode === "signin" ? (
                  <SignIn
                    routing="hash"
                    fallbackRedirectUrl={afterAuthUrl}
                    forceRedirectUrl={afterAuthUrl}
                    signUpUrl="/login"
                  />
                ) : (
                  <SignUp
                    routing="hash"
                    fallbackRedirectUrl={afterAuthUrl}
                    forceRedirectUrl={afterAuthUrl}
                    signInUrl="/login"
                  />
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between w-full pt-4 mt-4 border-t border-[color:var(--line)] text-[color:var(--muted)]">
                <button
                  type="button"
                  onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                  className="font-mono-nums text-[11px] uppercase tracking-[0.16em] text-[color:var(--primary)] transition-colors hover:text-[color:var(--ink)]"
                >
                  {mode === "signin" ? "Create an account" : "Sign in instead"}
                </button>
                <div className="flex items-center gap-1">
                  <Fingerprint className="h-3 w-3" />
                  <span className="font-mono-nums text-[10px] uppercase tracking-[0.18em]">
                    Clerk · Secured
                  </span>
                </div>
              </div>
            </div>
          </GlowBorder>
        </motion.div>
      </div>
    </ClickSpark>
  );
}
