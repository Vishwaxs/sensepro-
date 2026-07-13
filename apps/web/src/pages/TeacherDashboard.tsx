import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Camera,
  FileDown,
  Flag,
  Percent,
  ScanFace,
  Search,
  Users,
  UsersRound,
  WifiOff,
} from "lucide-react";
import {
  deriveRoster,
  fetchActiveSession,
  fetchIntervals,
  fetchStudents,
  subscribePresence,
} from "@/lib/data/roster";
import type { ActiveSession, IntervalRow } from "@/lib/data/roster";
import { exportSessionPdf } from "@/lib/data/report";
import type { RosterEntry } from "@/lib/types";
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

type LoadState = "loading" | "ready" | "error";

export function TeacherDashboard() {
  const [query, setQuery] = useState("");
  const [load, setLoad] = useState<LoadState>("loading");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [realtimeLive, setRealtimeLive] = useState(false);
  const studentsRef = useRef<Awaited<ReturnType<typeof fetchStudents>>>([]);
  const intervalsRef = useRef<Map<string, IntervalRow>>(new Map());

  const rederive = useCallback(() => {
    setRoster(deriveRoster(studentsRef.current, [...intervalsRef.current.values()]));
  }, []);

  /* Initial load: students + active session + its intervals — direct RLS
     reads, no backend endpoint. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [students, active] = await Promise.all([fetchStudents(), fetchActiveSession()]);
        if (cancelled) return;
        studentsRef.current = students;
        setSession(active);
        if (active) {
          const intervals = await fetchIntervals(active.id);
          if (cancelled) return;
          intervalsRef.current = new Map(intervals.map((iv) => [iv.id, iv]));
        }
        rederive();
        setLoad("ready");
      } catch {
        if (!cancelled) setLoad("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rederive]);

  /* Realtime: apply inserts/updates for the active session as they land.
     On drop the stale watermark shows; the channel auto-rejoins. */
  useEffect(() => {
    if (!session) return;
    const unsubscribe = subscribePresence(
      session.id,
      (row) => {
        intervalsRef.current.set(row.id, row);
        rederive();
      },
      setRealtimeLive,
    );
    return unsubscribe;
  }, [session, rederive]);

  const presentCount = roster.filter((r) => r.state === "PRESENT").length;
  const avgAttendance = roster.length
    ? (roster.filter((r) => r.state !== "ABSENT").length / roster.length) * 100
    : 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (r) => r.full_name.toLowerCase().includes(q) || r.student_id.toLowerCase().includes(q),
    );
  }, [query, roster]);

  const subtitle = session
    ? `${session.class_section}${session.subject ? " · " + session.subject : ""} — live session`
    : "No live session — roster shows the enrolled class";

  return (
    <div>
      <PageHeader
        title="Teacher console"
        subtitle={subtitle}
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void exportSessionPdf({
                  section: session?.class_section ?? "MCA-4B",
                  subject: session?.subject ?? null,
                  roster,
                })
              }
              disabled={roster.length === 0}
            >
              <FileDown className="size-4" aria-hidden="true" /> Export PDF
            </Button>
            <Link to="/capture">
              <Button>
                <Camera className="size-4" aria-hidden="true" /> Open capture kiosk
              </Button>
            </Link>
          </div>
        }
      />

      {/* KPI row */}
      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard label="Present" value={presentCount} icon={Users} tone="ok" note="recognised in the last re-ID pass" />
        <StatCard label="Total roster" value={roster.length} icon={UsersRound} note="enrolled with signed consent" />
        <StatCard label="Avg attendance" value={avgAttendance} decimals={0} suffix="%" icon={Percent} note="this session so far" />
        <StatCard label="Flags" value={0} icon={Flag} tone="warn" note="proctor queue — human review only" />
      </motion.div>

      {/* Live roster */}
      <motion.div {...rise} transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}>
        <Card className="mt-6">
          <CardHeader
            title="Live roster"
            hint="Presence updates arrive over Supabase Realtime — no polling."
            action={
              session && realtimeLive ? (
                <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted">
                  <LiveDot /> live
                </div>
              ) : session ? (
                <div className="flex items-center gap-2 font-mono text-[11.5px] text-warn">
                  <WifiOff className="size-3.5" aria-hidden="true" /> reconnecting — data may be stale
                </div>
              ) : null
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

          {load === "loading" ? (
            <p className="px-5 py-10 text-center font-mono text-[12.5px] text-muted">
              loading roster…
            </p>
          ) : load === "error" ? (
            <EmptyState
              icon={WifiOff}
              title="Could not load the roster"
              hint="Check your connection and role, then reload. Reads go directly to the database under row-level security."
            />
          ) : filtered.length === 0 ? (
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
