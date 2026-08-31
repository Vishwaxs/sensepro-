import { Link, useNavigate, useRouterState, Outlet } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radio,
  Users,
  BarChart3,
  Shield,
  User,
  Command,
  Fingerprint,
  ShieldAlert,
  LineChart,
  ClipboardList,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { ConnectionBadge, type ConnState } from "./ConnectionBadge";
import { cn } from "@/lib/utils";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/fx";
import { useAuth, signOut } from "@/lib/auth";
import type { AppRole } from "@/lib/auth-guard";
import { API_BASE } from "@/lib/api";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Radio;
  mono: string;
  roles: AppRole[];
  group: string;
}

const NAV: NavItem[] = [
  // Teacher
  {
    to: "/start",
    label: "Start Session",
    icon: Radio,
    mono: "STR",
    roles: ["teacher"],
    group: "Teacher",
  },
  {
    to: "/teacher",
    label: "Live Session",
    icon: Users,
    mono: "TCH",
    roles: ["teacher"],
    group: "Teacher",
  },
  {
    to: "/sessions",
    label: "Sessions",
    icon: ClipboardList,
    mono: "SES",
    roles: ["teacher"],
    group: "Teacher",
  },
  {
    to: "/proctor",
    label: "Proctor Queue",
    icon: ShieldAlert,
    mono: "PRO",
    roles: ["teacher"],
    group: "Teacher",
  },

  // Management
  {
    to: "/management",
    label: "Cohort Analytics",
    icon: BarChart3,
    mono: "MGT",
    roles: ["management"],
    group: "Management",
  },
  {
    to: "/trends",
    label: "Aggregate Trends",
    icon: LineChart,
    mono: "TRD",
    roles: ["management"],
    group: "Management",
  },

  // Admin
  {
    to: "/admin",
    label: "System Console",
    icon: Shield,
    mono: "ADM",
    roles: ["admin"],
    group: "Admin",
  },
  {
    to: "/enrollment",
    label: "Enrollment Station",
    icon: Fingerprint,
    mono: "ENR",
    roles: ["admin"],
    group: "Admin",
  },

  // Student
  {
    to: "/me",
    label: "My Attendance",
    icon: User,
    mono: "ME",
    roles: ["student"],
    group: "Student",
  },
];

export function AppShell({ children, title }: { children: ReactNode; title?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [backendState, setBackendState] = useState<ConnState>("RECONNECTING");
  const { user } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    let active = true;

    async function refreshBackendState() {
      if (!navigator.onLine) {
        if (active) setBackendState("OFFLINE");
        return;
      }

      if (active) setBackendState("RECONNECTING");
      try {
        const response = await fetch(`${API_BASE}/healthz`, { cache: "no-store" });
        if (active) setBackendState(response.ok ? "LIVE" : "OFFLINE");
      } catch {
        if (active) setBackendState("OFFLINE");
      }
    }

    const handleOnline = () => void refreshBackendState();
    const handleOffline = () => setBackendState("OFFLINE");
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshBackendState();
    };

    void refreshBackendState();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const initials = user?.full_name
    ? user.full_name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("")
    : "…";

  async function handleSignOut() {
    await signOut();
    nav({ to: "/login" });
  }

  const userRole = user?.role;
  const isAdmin = userRole === "admin";
  const visibleNav = NAV.filter((n) => userRole && (isAdmin || n.roles.includes(userRole)));

  const navContent = (
    <>
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-6">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--line)]"
          style={{ background: "linear-gradient(135deg, var(--primary-deep), var(--primary))" }}
        >
          <Command className="h-4 w-4 text-white" strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-[15px] font-extrabold leading-none tracking-tight text-[color:var(--ink)]">
            SensePro<span className="text-gradient">+</span>
          </div>
          <div className="sp-eyebrow mt-1.5 text-[9.5px] leading-none">Command Center</div>
        </div>
      </div>

      <div className="mx-5 sp-hairline" />

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 px-3 pt-4 overflow-y-auto">
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="sp-eyebrow text-[9.5px]">
            {userRole ? `${userRole.toUpperCase()} WORKSPACE` : "WORKSPACE"}
          </span>
          {isAdmin && (
            <span className="text-[9px] font-mono-nums uppercase px-1.5 py-0.5 rounded bg-[color:var(--primary)]/15 text-[color:var(--primary)] font-semibold">
              Superuser
            </span>
          )}
        </div>
        {visibleNav.map((n, idx) => {
          const active = pathname.startsWith(n.to.split("?")[0]!);
          const Icon = n.icon;
          const showGroupHeader = isAdmin && (idx === 0 || visibleNav[idx - 1]?.group !== n.group);

          return (
            <div key={n.to}>
              {showGroupHeader && (
                <div className="px-3 pt-3 pb-1 text-[9px] font-mono uppercase tracking-[0.14em] text-[color:var(--muted)]/70">
                  {n.group}
                </div>
              )}
              <Link
                to={n.to}
                data-active={active}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "sp-focus group relative flex h-11 items-center gap-3 rounded-md px-3 text-[13px] transition-colors duration-200",
                  active
                    ? "bg-[color:var(--surface-2)] text-[color:var(--ink)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
                    : "text-[color:var(--muted)] hover:bg-[color:var(--surface-2)]/60 hover:text-[color:var(--ink)]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full transition-opacity duration-200",
                    active ? "opacity-100" : "opacity-0",
                  )}
                  style={{ background: "var(--primary)" }}
                />
                <Icon
                  className={cn(
                    "h-[15px] w-[15px] transition-colors duration-200",
                    active && "text-[color:var(--primary)]",
                  )}
                  strokeWidth={2}
                />
                <span className="flex-1 truncate">{n.label}</span>
                <span className="font-mono-nums text-[9.5px] tracking-[0.14em] text-[color:var(--muted)]">
                  {n.mono}
                </span>
              </Link>
            </div>
          );
        })}
      </nav>

      {/* Operator card */}
      <div className="mt-auto p-4">
        <div className="flex items-center gap-3 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/70 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] font-mono-nums text-[11px] font-semibold text-[color:var(--ink)]">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-tight text-[color:var(--ink)] font-medium">
              {user?.full_name ?? "Loading…"}
            </div>
            <div
              className="mt-1 flex items-center gap-1"
              aria-label={`Role: ${user?.role ?? "not assigned"}`}
            >
              <span className="rounded bg-[color:var(--primary)]/15 px-1.5 py-0.5 font-mono-nums text-[9px] font-semibold uppercase tracking-[0.16em] text-[color:var(--primary)]">
                {user?.role ?? "No Role"}
              </span>
            </div>
          </div>
          <ThemeToggle className="shrink-0 bg-[color:var(--surface)] hover:bg-[color:var(--surface-2)] border-transparent hover:border-[color:var(--line)]" />
          <button
            onClick={handleSignOut}
            className="sp-focus flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--muted)] transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)]"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="app-bg relative flex min-h-screen w-full overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="glass-frosted sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col rounded-none border-0 border-r border-[color:var(--line)] lg:flex">
        {navContent}
      </aside>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 flex h-screen w-[280px] flex-col bg-[color:var(--surface)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--muted)] hover:bg-[color:var(--surface-2)]"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
        {navContent}
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass-frosted sticky top-0 z-20 flex h-14 items-center gap-4 rounded-none border-0 border-b border-[color:var(--line)] px-4 sm:px-8">
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[color:var(--muted)] hover:bg-[color:var(--surface-2)] lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 sm:flex">
            <h1 className="truncate font-display text-[17px] font-extrabold leading-none tracking-tight text-[color:var(--ink)]">
              {title}
            </h1>
            <span className="sp-eyebrow text-[10px]">/{pathname.replace(/^\//, "")}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div
              aria-label={new Date().toDateString()}
              className="hidden font-mono-nums text-[11px] tracking-wide text-[color:var(--muted)] sm:block"
            >
              {new Date().toLocaleDateString(undefined, {
                weekday: "short",
                day: "2-digit",
                month: "short",
              })}
            </div>
            <ConnectionBadge
              state={backendState}
              label={
                backendState === "LIVE"
                  ? "API ready"
                  : backendState === "RECONNECTING"
                    ? "Checking API"
                    : "API offline"
              }
            />
          </div>
        </header>
        <AnimatePresence mode="wait">
          <motion.main
            key={pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8"
          >
            {children ?? <Outlet />}
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}
