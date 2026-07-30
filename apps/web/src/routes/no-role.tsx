import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/no-role")({
  head: () => ({
    meta: [{ title: "No Role · SensePro+" }],
  }),
  component: NoRolePage,
});

function NoRolePage() {
  return (
    <div className="app-bg flex min-h-screen items-center justify-center px-4">
      <div className="glass-panel max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10">
          <ShieldAlert className="h-7 w-7 text-[color:var(--warn)]" />
        </div>
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--warn)]">
          Access · Denied
        </div>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-[color:var(--ink)]">
          No role assigned
        </h1>
        <p className="mt-3 text-sm text-[color:var(--muted)]">
          Your account exists but has no role configured. Contact your administrator to assign a
          role (teacher, management, admin, or student) before you can access the console.
        </p>
        <div className="mt-6">
          <Link
            to="/login"
            className="inline-flex h-11 items-center justify-center rounded-md bg-[color:var(--primary)] px-5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--primary-deep)]"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
