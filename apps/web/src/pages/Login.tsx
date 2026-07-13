import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ScanFace } from "lucide-react";
import { decodeJwtPayload, ROLE_HOME } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* Handler only — no HTML form post (design-system rule). Real Supabase Auth;
     the role comes back on the JWT (see lib/auth.tsx), not a client choice. */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password to continue.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    const claims = data.session ? decodeJwtPayload(data.session.access_token) : {};
    const role = claims.app_role as keyof typeof ROLE_HOME | undefined;
    navigate(role ? ROLE_HOME[role] : "/login");
    if (!role) {
      setError(
        "Signed in, but no role is attached to this account yet. Contact an administrator.",
      );
    }
  };

  return (
    <div className="bg-grid bg-glow relative grid min-h-full place-items-center px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="panel relative z-10 w-full max-w-[400px] p-7"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl border border-primary/30 bg-primary/15">
            <ScanFace className="size-5.5 text-primary" aria-hidden="true" />
          </div>
          <h1 className="font-display text-[22px] font-800 tracking-tight text-ink">SensePro+</h1>
          <p className="mt-1 font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
            Classroom command center
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-3.5">
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@christuniversity.in"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="mt-3 text-[13px] text-bad">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="mt-5 w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-5 text-center text-xs leading-relaxed text-muted">
          Access is role-scoped. Students see only their own attendance record;
          engagement data exists only as class-level aggregates.
        </p>
      </motion.div>
    </div>
  );
}
