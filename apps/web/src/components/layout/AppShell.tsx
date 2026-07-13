import { useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import {
  Camera,
  GaugeCircle,
  LogOut,
  Menu,
  ScanFace,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import type { Role } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: Role[];
}

const NAV: NavItem[] = [
  { to: "/capture", label: "Capture", icon: Camera, roles: ["teacher", "admin"] },
  { to: "/teacher", label: "Teacher", icon: ScanFace, roles: ["teacher", "admin"] },
  { to: "/management", label: "Management", icon: GaugeCircle, roles: ["management", "admin"] },
  { to: "/admin", label: "Admin", icon: ShieldCheck, roles: ["admin"] },
  { to: "/me", label: "My record", icon: UserRound, roles: ["student", "admin"] },
];

function SideNav({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const items = NAV.filter((n) => n.roles.includes(role));
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 px-3">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
              "transition-colors duration-150",
              isActive
                ? "bg-primary/15 text-ink border border-primary/30"
                : "border border-transparent text-muted hover:bg-surface-2 hover:text-ink",
            )
          }
        >
          <Icon className="size-[18px]" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <div className="grid size-8 place-items-center rounded-lg bg-primary/15 border border-primary/30">
        <ScanFace className="size-4.5 text-primary" aria-hidden="true" />
      </div>
      <div>
        <div className="font-display text-[15px] font-800 tracking-tight text-ink leading-none">
          SensePro+
        </div>
        <div className="mt-0.5 font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
          Command Center
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // RequireRole already gates each nested route; this is the fallback for
  // any route mounted directly under AppShell without its own guard.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="bg-grid bg-glow relative flex min-h-full">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 z-20 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface/80 backdrop-blur-md lg:flex">
        <Brand />
        <SideNav role={user.role} />
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 border border-line font-mono text-xs text-accent">
              {initials(user.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{user.name}</div>
              <div className="font-mono text-[10.5px] tracking-wider text-muted uppercase">
                {user.role}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              title="Sign out"
              onClick={handleSignOut}
            >
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-line bg-surface">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <SideNav role={user.role} onNavigate={() => setDrawerOpen(false)} />
            <div className="border-t border-line p-4">
              <Button variant="outline" size="sm" className="w-full" onClick={handleSignOut}>
                <LogOut className="size-4" aria-hidden="true" /> Sign out
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/80 px-4 py-3 backdrop-blur-md lg:hidden">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
          <span className="font-display text-[15px] font-800 text-ink">SensePro+</span>
          <span className="ml-auto font-mono text-[10.5px] tracking-wider text-muted uppercase">
            {user.role}
          </span>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>

        <footer className="border-t border-line px-6 py-3 text-center font-mono text-[10.5px] tracking-wider text-muted uppercase">
          Frames processed in memory · never stored · embeddings-only identity
        </footer>
      </div>
    </div>
  );
}

export function RoleRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOME[user.role]} replace />;
}
