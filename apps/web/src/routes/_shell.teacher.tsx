import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Download, Filter, QrCode, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { KpiCard } from "@/components/sp/KpiCard";
import { StateChip } from "@/components/sp/StateChip";
import { AbsenteeQR } from "@/components/sp/AbsenteeQR";
import { API_BASE } from "@/lib/api";
import {
  deriveRoster,
  fetchActiveSession,
  fetchIntervals,
  fetchStudents,
  subscribePresence,
} from "@/lib/data/roster";
import type { ActiveSession, IntervalRow } from "@/lib/data/roster";
import type { AttendanceState, RosterEntry } from "@/lib/data/types";
import { guardRoute } from "@/lib/auth-guard";
import { ProctorReviewPanel } from "@/components/ProctorReviewPanel";
import { cn } from "@/lib/utils";
import { exportSessionPdf } from "@/lib/data/report";
import { overridePresence } from "@/lib/data/attendance";
import { fetchZoneAggregates, latestWindow } from "@/lib/data/engagement";
import type { ZoneAggregateRow } from "@/lib/data/engagement";
import { VneiPanel } from "@/components/charts/VneiPanel";

export const Route = createFileRoute("/_shell/teacher")({
  beforeLoad: guardRoute(["teacher"]),
  head: () => ({
    meta: [{ title: "Teacher · SensePro+" }],
  }),
  component: TeacherPage,
});

const OVERRIDE_STATES: AttendanceState[] = ["PRESENT", "UNVERIFIED", "ABSENT"];

function formatRelative(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const diff = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ${diff % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function TeacherPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [realtimeLive, setRealtimeLive] = useState(false);
  const [pendingFlags, setPendingFlags] = useState(0);
  const [filter, setFilter] = useState<"ALL" | AttendanceState>("ALL");
  const [now, setNow] = useState(() => Date.now());
  const [exporting, setExporting] = useState(false);
  const [overriding, setOverriding] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);

  const studentsRef = useRef<Awaited<ReturnType<typeof fetchStudents>>>([]);
  const intervalsRef = useRef<Map<string, IntervalRow>>(new Map());
  const flashRef = useRef<Map<string, number>>(new Map());

  const rederive = useCallback(() => {
    setRoster((prev) => {
      const next = deriveRoster(studentsRef.current, [...intervalsRef.current.values()]);
      next.forEach((r) => {
        const old = prev.find((p) => p.student_id === r.student_id);
        if (old && old.state !== r.state) {
          flashRef.current.set(r.student_id, Date.now());
        }
      });
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const active = await fetchActiveSession();
        if (cancelled) return;
        const students =
          active?.mode === "workshop" ? [] : await fetchStudents(active?.class_section);
        if (cancelled) return;
        studentsRef.current = students;
        setSession(active);
        if (active?.mode === "lecture") {
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

  useEffect(() => {
    if (!session || session.mode !== "lecture") return;
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

  // Tick every second for "last seen" relative display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const c = { PRESENT: 0, UNVERIFIED: 0, ABSENT: 0 } as Record<AttendanceState, number>;
    for (const r of roster) c[r.state]++;
    return c;
  }, [roster]);

  const studentNames = useMemo(
    () => new Map(studentsRef.current.map((s) => [s.id, s.full_name])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const present = counts.PRESENT;
  const total = roster.length;
  const filtered = useMemo(
    () => (filter === "ALL" ? roster : roster.filter((r) => r.state === filter)),
    [roster, filter],
  );

  const filterCount = (k: "ALL" | AttendanceState) => (k === "ALL" ? total : counts[k]);

  async function handleExport() {
    if (!session) return;
    setExporting(true);
    try {
      await exportSessionPdf({ section: session.class_section, subject: session.subject, roster });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handleOverride(studentId: string, state: AttendanceState) {
    if (!session) return;
    const prevRoster = roster;
    // Optimistic update, reverted on failure — never claim a state that
    // wasn't actually persisted.
    setRoster((r) => r.map((row) => (row.student_id === studentId ? { ...row, state } : row)));
    setOverriding(studentId);
    try {
      // studentId here is the roster's display key (reg_no); resolve back to
      // the students.id the backend/DB actually keys on.
      const student = studentsRef.current.find((s) => s.reg_no === studentId);
      if (!student) throw new Error("Unknown student");
      await overridePresence(session.id, student.id, state);
      toast.success(`Marked ${state.toLowerCase()}`);
    } catch (err) {
      setRoster(prevRoster);
      toast.error(err instanceof Error ? err.message : "Override failed — not saved");
    } finally {
      setOverriding(null);
    }
  }

  if (load === "error") {
    return (
      <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
        <WifiOff className="h-8 w-8 opacity-50" />
        <div className="font-display text-lg font-medium text-[color:var(--ink)]">
          Could not load the roster
        </div>
        <p className="text-sm">Check your connection and role, then refresh.</p>
      </div>
    );
  }

  if (load === "ready" && session?.mode === "exam") {
    return (
      <ExamTeacherView
        session={session}
        studentNames={studentNames}
        pendingFlags={pendingFlags}
        onPendingCount={setPendingFlags}
      />
    );
  }

  if (load === "ready" && session?.mode === "workshop") {
    return <WorkshopTeacherView session={session} />;
  }

  return (
    <div className="space-y-8">
      {load === "ready" && !session && (
        <div className="rounded-md border border-dashed border-[color:var(--warn)]/50 bg-[color:var(--warn)]/5 px-4 py-3 text-xs text-[color:var(--warn)]">
          No live session — start one from Capture. The roster below shows every enrolled student as
          ABSENT until then; nothing here is a real attendance record yet.
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Present"
          value={present}
          suffix={`/ ${total}`}
          accent="ok"
          hint="Verified now"
        />
        <KpiCard label="Total roster" value={total} accent="primary" hint="Enrolled" />
        <KpiCard
          label="Attendance"
          value={total > 0 ? Math.round((present / total) * 100) : 0}
          suffix="%"
          accent="accent"
          hint="Live"
        />
      </div>

      <div>
        {/* Roster */}
        <section className="glass-panel overflow-hidden">
          <header className="flex flex-col gap-4 border-b border-[color:var(--line)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Live roster
              </div>
              <div className="mt-0.5 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                {session
                  ? `${session.class_section}${session.subject ? " · " + session.subject : ""}`
                  : "No live session"}
              </div>
              <div className="mt-1 flex items-center gap-2">
                {session && realtimeLive ? (
                  <span className="flex items-center gap-1.5 font-mono-nums text-[11px] text-[color:var(--ok)]">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--ok)] opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--ok)]" />
                    </span>
                    realtime live
                  </span>
                ) : session ? (
                  <span className="flex items-center gap-1.5 font-mono-nums text-[11px] text-[color:var(--warn)]">
                    <WifiOff className="h-3 w-3" /> reconnecting...
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-1">
                {(["ALL", "PRESENT", "UNVERIFIED", "ABSENT"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    aria-pressed={filter === k}
                    className={cn(
                      "sp-focus min-h-12 rounded px-3 font-mono-nums text-[11px] uppercase tracking-wider transition-colors",
                      filter === k
                        ? "bg-[color:var(--primary)] text-white"
                        : "text-[color:var(--muted)] hover:text-[color:var(--ink)]",
                    )}
                  >
                    {k} <span className="ml-1 opacity-70">{filterCount(k)}</span>
                  </button>
                ))}
              </div>
              <button className="sp-focus flex h-12 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-4 text-xs text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]">
                <Filter className="h-3.5 w-3.5" /> Advanced
              </button>
              <button
                onClick={() => setShowQr(true)}
                disabled={!session}
                className="sp-focus flex h-12 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-4 text-xs text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <QrCode className="h-3.5 w-3.5" /> Absentee QR
              </button>
              <button
                onClick={() => void handleExport()}
                disabled={!session || exporting || roster.length === 0}
                className="sp-focus flex h-12 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-xs font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                {exporting ? "Exporting…" : "Export session report (PDF)"}
              </button>
            </div>
          </header>

          <div className="max-h-[560px] overflow-y-auto">
            {load === "loading" ? (
              <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
                loading…
              </div>
            ) : (
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-[color:var(--surface)] backdrop-blur">
                  <tr className="border-b border-[color:var(--line)]">
                    {["", "Reg no", "Name", "State", "Override", "Last seen"].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-2 text-left font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const flashedAt = flashRef.current.get(r.student_id);
                    const flashing = !!flashedAt && now - flashedAt < 900;
                    return (
                      <tr
                        key={r.student_id}
                        className={cn(
                          "border-b border-[color:var(--line)]/60",
                          flashing && "row-flash",
                        )}
                      >
                        <td className="w-12 px-4 py-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--line)] font-mono-nums text-[10px] font-semibold text-[color:var(--ink)] bg-[color:var(--surface-2)]">
                            {r.full_name
                              .split(" ")
                              .map((p) => p[0])
                              .slice(0, 2)
                              .join("")}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono-nums text-xs text-[color:var(--muted)]">
                          {r.student_id}
                        </td>
                        <td className="px-4 py-3 text-[15px] text-[color:var(--ink)]">
                          {r.full_name}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <StateChip state={r.state} />
                            {r.state === "PRESENT" && r.via === "qr" && (
                              <span
                                title="Verified via absentee QR selfie"
                                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--accent)]"
                              >
                                <QrCode className="h-3 w-3" /> QR
                              </span>
                            )}
                            {r.via === "override" && (
                              <span
                                title="Manually overridden by a teacher"
                                className="font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]"
                              >
                                override
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            aria-label={`Override ${r.full_name}'s state`}
                            disabled={!session || overriding === r.student_id}
                            value={r.state}
                            onChange={(e) =>
                              void handleOverride(r.student_id, e.target.value as AttendanceState)
                            }
                            className="sp-focus h-9 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-2 font-mono-nums text-[11px] text-[color:var(--ink)] outline-none focus:border-[color:var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {OVERRIDE_STATES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td
                          className="px-4 py-3 font-mono-nums text-xs text-[color:var(--muted)]"
                          title={r.last_seen ?? undefined}
                        >
                          {formatRelative(r.last_seen, now)}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-10 text-center font-mono-nums text-xs text-[color:var(--muted)]"
                      >
                        No rows match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      {/* Absentee QR fallback — same panel capture.tsx uses, reachable here too
          so a teacher watching from the dashboard (not standing at the kiosk)
          can still open a verification window for absent students. */}
      {showQr && session && (
        <div className="fixed bottom-6 right-6 z-40 w-75">
          <AbsenteeQR sessionId={session.id} apiBase={API_BASE} onClose={() => setShowQr(false)} />
        </div>
      )}
    </div>
  );
}

function ExamTeacherView({
  session,
  studentNames,
  pendingFlags,
  onPendingCount,
}: {
  session: ActiveSession;
  studentNames: Map<string, string>;
  pendingFlags: number;
  onPendingCount: (count: number) => void;
}) {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--warn)]">
            Examination control
          </div>
          <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
            {session.subject ?? session.class_section}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Review sustained device, additional-person, and off-screen head-pose events. Every item
            remains a candidate event until a teacher decides.
          </p>
        </div>
        <span className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-3 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--warn)]">
          <ShieldAlert className="h-4 w-4" /> exam session open
        </span>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard
          label="Awaiting review"
          value={pendingFlags}
          accent={pendingFlags > 0 ? "warn" : "ok"}
          hint="Human decision required"
        />
        <KpiCard
          label="Candidate roster"
          value={studentNames.size}
          accent="primary"
          hint="Exam cohort"
        />
        <KpiCard label="Review policy" value="Human" accent="muted" hint="No automatic verdicts" />
      </div>

      <ProctorReviewPanel
        sessionId={session.id}
        studentNames={studentNames}
        onPendingCount={onPendingCount}
      />
    </div>
  );
}

function WorkshopTeacherView({ session }: { session: ActiveSession }) {
  const [rows, setRows] = useState<ZoneAggregateRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setRows([]);
    setState("loading");
    setLastUpdatedAt(null);

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchZoneAggregates(session.id);
        if (!cancelled) {
          setRows(next);
          setState("ready");
          setLastUpdatedAt(new Date());
        }
      } catch {
        if (!cancelled) setState("error");
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [retryRevision, session.id]);

  const latest = useMemo(() => latestWindow(rows), [rows]);
  const zoneRows = [...latest.byZone.values()].filter((row) => row.zone !== "class");
  const classRow = latest.byZone.get("class");
  const tracked = zoneRows.reduce((sum, row) => sum + row.n_tracked, 0);
  const enrolled = zoneRows.reduce((sum, row) => sum + row.enrolled_in_zone, 0);
  const meanVnei = classRow
    ? classRow.vnei
    : tracked > 0
      ? zoneRows.reduce((sum, row) => sum + row.vnei * row.n_tracked, 0) / tracked
      : null;
  const meanCoverage = classRow
    ? classRow.coverage
    : enrolled > 0
      ? zoneRows.reduce((sum, row) => sum + row.coverage * row.enrolled_in_zone, 0) / enrolled
      : null;
  const reportableWindows = new Set(
    rows.filter((row) => row.zone !== "class").map((row) => row.window_start),
  ).size;
  const refreshedAt = lastUpdatedAt?.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
            Workshop engagement
          </div>
          <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
            {session.subject ?? "Live workshop"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Anonymous zone-level posture, activity, and device signals. This view contains no
            participant identities or individual outcomes.
          </p>
          <p className="mt-2 font-mono-nums text-[11px] text-[color:var(--muted)]">
            {session.class_section} · started {new Date(session.starts_at).toLocaleString()}
            {refreshedAt ? ` · data refreshed ${refreshedAt}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex min-h-11 items-center gap-2 rounded-md border px-3 font-mono-nums text-[11px] uppercase tracking-wider",
            state === "error"
              ? "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]"
              : "border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 text-[color:var(--accent)]",
          )}
          aria-live="polite"
        >
          {state === "error" ? <WifiOff className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
          {state === "loading"
            ? "connecting aggregate stream"
            : state === "error"
              ? "aggregate stream unavailable"
              : "aggregate stream live"}
        </span>
      </header>

      {state === "loading" ? (
        <section className="glass-panel p-5 sm:p-6" aria-busy="true">
          <div className="grid min-h-52 place-items-center font-mono-nums text-xs text-[color:var(--muted)]">
            Loading workshop windows…
          </div>
        </section>
      ) : state === "error" ? (
        <section className="glass-panel p-5 sm:p-6">
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-[color:var(--muted)]">
            <WifiOff className="h-8 w-8 opacity-50" />
            <div>
              <p className="font-medium text-[color:var(--ink)]">
                Workshop aggregates could not be refreshed.
              </p>
              <p className="mt-1 max-w-md text-sm">
                No cached values are shown as current. Check the connection and try again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setState("loading");
                setRetryRevision((revision) => revision + 1);
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-4 text-sm font-semibold text-[color:var(--ink)] transition-colors hover:border-[color:var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label={classRow ? "Class signal" : "Weighted zone signal"}
              value={meanVnei === null ? "Withheld" : Math.round(meanVnei * 100)}
              suffix={meanVnei === null ? undefined : "%"}
              accent={meanVnei === null ? "muted" : "accent"}
              hint={
                meanVnei === null
                  ? "Waiting for a reportable window"
                  : classRow
                    ? "Latest reportable window"
                    : "Peak-visible weighted · latest window"
              }
            />
            <KpiCard
              label="Coverage in reportable zones"
              value={meanCoverage === null ? "—" : Math.round(meanCoverage * 100)}
              suffix={meanCoverage === null ? undefined : "%"}
              accent={meanCoverage !== null && meanCoverage < 0.5 ? "warn" : "primary"}
              hint="Peak visible ÷ configured roster"
            />
            <KpiCard
              label="Zones reported"
              value={zoneRows.length}
              accent={zoneRows.length > 0 ? "ok" : "muted"}
              hint="Latest window · privacy floor met"
            />
            <KpiCard
              label="Reportable windows"
              value={reportableWindows}
              accent={reportableWindows > 0 ? "ok" : "muted"}
              hint="At least one zone persisted"
            />
          </div>

          <section className="glass-panel p-5 sm:p-6">
            <VneiPanel rows={rows} />
          </section>
        </>
      )}

      <p className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-4 py-3 font-mono-nums text-[11px] leading-relaxed text-[color:var(--muted)]">
        A zone is reported only when at least five faces are simultaneously visible and
        pose-observable. Zone-level summaries are weighted by peak visible count; missing data is
        shown as withheld, never as zero engagement.
      </p>
    </div>
  );
}
