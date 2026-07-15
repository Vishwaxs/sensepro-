import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useState } from "react";
import { Command } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [{ title: "Sign in · SensePro+" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !pwd) return;
    setBusy(true);

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password: pwd,
          options: { data: { full_name: name } },
        });
        if (error) throw error;
        toast.success("Account created. Check your email to confirm.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pwd });
        if (error) throw error;
        nav({ to: "/teacher" });
        return;
      }
    } catch (err: any) {
      // Supabase not configured — fall back to demo mode
      if (err?.message?.includes("placeholder") || err?.message?.includes("fetch")) {
        toast.info("Demo mode — Supabase not configured. Redirecting to console.");
        nav({ to: "/teacher" });
        return;
      }
      toast.error(err?.message ?? "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-bg relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-0 h-[600px] w-[600px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(29,78,216,0.45), transparent 60%)" }}
        animate={{ opacity: [0.6, 0.9, 0.6] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 h-[420px] w-[420px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(34,211,238,0.15), transparent 60%)" }}
        animate={{ opacity: [0.3, 0.55, 0.3] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="glass-panel relative z-10 w-full max-w-md p-8"
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-md border border-[color:var(--line)]"
            style={{ background: "linear-gradient(135deg, var(--primary-deep), var(--primary))" }}
          >
            <Command className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-display text-xl font-extrabold tracking-tight">
              SensePro<span className="text-[color:var(--accent)]">+</span>
            </div>
            <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
              Console · Access
            </div>
          </div>
        </div>

        <h1 className="mt-8 font-display text-3xl font-extrabold tracking-tight text-[color:var(--ink)]">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          {mode === "signin"
            ? "Faculty & staff console. Student devices sign in via campus SSO."
            : "Register with your campus email. Your admin will assign roles after verification."}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <Field label="Full name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dr. R. Rao"
                className="input-field"
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@campus"
              className="input-field"
              autoComplete="email"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="••••••••"
              className="input-field"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </Field>

          <button
            type="submit"
            disabled={busy}
            className="h-12 w-full rounded-md bg-[color:var(--primary)] text-sm font-semibold tracking-wide text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] disabled:opacity-60"
          >
            {busy ? "Verifying…" : mode === "signin" ? "Enter console" : "Create account"}
          </button>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent)] transition-colors hover:text-[color:var(--ink)]"
            >
              {mode === "signin" ? "Create an account" : "Already have an account? Sign in"}
            </button>
            <span className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              DPDP compliant
            </span>
          </div>
        </form>
      </motion.div>

      <style>{`
        .input-field {
          width: 100%;
          height: 48px;
          padding: 0 14px;
          border-radius: 10px;
          background: color-mix(in oklab, var(--surface-2) 92%, transparent);
          border: 1px solid var(--line);
          color: var(--ink);
          font-family: var(--font-mono);
          font-size: 13px;
          outline: none;
          transition: border-color .15s ease, box-shadow .15s ease;
        }
        .input-field::placeholder { color: var(--muted); }
        .input-field:focus {
          border-color: var(--primary);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 25%, transparent);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
        {label}
      </div>
      {children}
    </label>
  );
}
