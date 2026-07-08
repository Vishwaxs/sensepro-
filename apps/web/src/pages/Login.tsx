import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { GaugeCircle, ScanFace, ShieldCheck, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ROLES: { role: Role; label: string; icon: LucideIcon }[] = [
  { role: "teacher", label: "Teacher", icon: ScanFace },
  { role: "management", label: "Management", icon: GaugeCircle },
  { role: "admin", label: "Admin", icon: ShieldCheck },
  { role: "student", label: "Student", icon: UserRound },
];

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>("teacher");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  /* Handler only — no HTML form post (design-system rule). Real Supabase
     Auth replaces this stub in Week 2. */
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password to continue.");
      return;
    }
    setError(null);
    signIn({ name: email.split("@")[0] || "User", email: email.trim(), role });
    navigate(ROLE_HOME[role]);
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
          <fieldset className="mb-4">
            <legend className="mb-1.5 text-[13px] font-medium text-ink">Sign in as</legend>
            {/* Toggle-button group (aria-pressed) rather than an ARIA
                radiogroup: each is an independent Tab stop, so no arrow-key
                roving-tabindex contract is implied. */}
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Role">
              {ROLES.map(({ role: r, label, icon: Icon }) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border text-[13px] font-medium",
                    "transition-colors duration-150",
                    role === r
                      ? "border-primary/50 bg-primary/15 text-ink"
                      : "border-line bg-surface-2 text-muted hover:border-muted/50 hover:text-ink",
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

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

          <Button type="submit" size="lg" className="mt-5 w-full">
            Sign in
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
