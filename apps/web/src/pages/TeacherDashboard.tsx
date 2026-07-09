import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Camera, Flag, Percent, ScanFace, Search, Users, UsersRound } from "lucide-react";
import { MOCK_SECTION, MOCK_SUBJECT, mockRoster } from "@/lib/mock";
import { cn, fmtDuration, initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { StateBadge } from "@/components/StateBadge";
import { EmptyState } from "@/components/EmptyState";
import { LiveDot } from "@/components/LiveDot";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function TeacherDashboard() {
  const [query, setQuery] = useState("");

  const presentCount = mockRoster.filter((r) => r.state === "PRESENT").length;
  const avgAttendance =
    (mockRoster.filter((r) => r.state !== "ABSENT").length / mockRoster.length) * 100;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mockRoster;
    return mockRoster.filter(
      (r) => r.full_name.toLowerCase().includes(q) || r.student_id.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div>
      <PageHeader
        title="Teacher console"
        subtitle={`${MOCK_SECTION} · ${MOCK_SUBJECT} — live session`}
        action={
          <Link to="/capture">
            <Button>
              <Camera className="size-4" aria-hidden="true" /> Open capture kiosk
            </Button>
          </Link>
        }
      />

      {/* KPI row */}
      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard label="Present" value={presentCount} icon={Users} tone="ok" note="recognised in the last re-ID pass" />
        <StatCard label="Total roster" value={mockRoster.length} icon={UsersRound} note="enrolled with signed consent" />
        <StatCard label="Avg attendance" value={avgAttendance} decimals={0} suffix="%" icon={Percent} note="this session so far" />
        <StatCard label="Flags" value={0} icon={Flag} tone="warn" note="proctor queue — human review only" />
      </motion.div>

      {/* Live roster */}
      <motion.div {...rise} transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}>
        <Card className="mt-6">
          <CardHeader
            title="Live roster"
            hint="Presence updates on every re-identification pass."
            action={
              <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted">
                <LiveDot /> live
              </div>
            }
          />
          <div className="border-t border-line px-5 py-3">
            <div className="relative max-w-xs">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                aria-label="Search roster"
                placeholder="Search name or ID…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-h-10 w-full rounded-lg border border-line bg-surface-2 pr-3 pl-9 text-[13px] text-ink placeholder:text-muted/70 focus:border-primary"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={ScanFace}
              title="No students match"
              hint="Try a different name or student ID."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13.5px]">
                <thead>
                  <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Student</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">ID</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Last seen</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">Present</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.student_id} className="border-b border-line/60 last:border-0 hover:bg-surface-2/50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "grid size-8 shrink-0 place-items-center rounded-full border font-mono text-[11px]",
                              r.state === "PRESENT"
                                ? "border-ok/30 bg-ok/10 text-ok"
                                : "border-line bg-surface-2 text-muted",
                            )}
                            aria-hidden="true"
                          >
                            {initials(r.full_name)}
                          </span>
                          <span className="font-medium text-ink">{r.full_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-muted">{r.student_id}</td>
                      <td className="px-4 py-3">
                        <StateBadge state={r.state} />
                      </td>
                      <td className="px-4 py-3 font-mono text-muted">
                        {r.last_seen_ts === null ? "—" : `${Math.round(r.last_seen_ts)}s ago`}
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-ink">
                        {fmtDuration(r.present_seconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
