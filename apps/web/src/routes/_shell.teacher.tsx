import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, Filter, Phone, Users2, Eye } from "lucide-react";
import { KpiCard } from "@/components/sp/KpiCard";
import { StateChip } from "@/components/sp/StateChip";
import { mockFlags, mockRoster } from "@/lib/data/mock";
import type { AttendanceState, ProctorFlag, ProctorFlagType, RosterEntry } from "@/lib/data/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_shell/teacher")({
  head: () => ({
    meta: [{ title: "Teacher · SensePro+" }],
  }),
  component: TeacherPage,
});

const STATE_ORDER: AttendanceState[] = ["PRESENT", "UNVERIFIED", "ABSENT"];

function nextState(s: AttendanceState): AttendanceState {
  // Bias flow: PRESENT→UNVERIFIED→ABSENT→PRESENT (recovery)
  return STATE_ORDER[(STATE_ORDER.indexOf(s) + 1) % STATE_ORDER.length];
}

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
  const [roster, setRoster] = useState<RosterEntry[]>(() => mockRoster());
  const [flags, setFlags] = useState<ProctorFlag[]>(mockFlags());
  const [filter, setFilter] = useState<"ALL" | AttendanceState>("ALL");
  const [now, setNow] = useState(() => Date.now());
  const flashRef = useRef<Map<string, number>>(new Map());
  const [, forceFlash] = useState(0);

  // Tick every second for "last seen" relative display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Mock stream: emit a state transition every ~2.5s
  useEffect(() => {
    const id = setInterval(() => {
      setRoster((prev) => {
        if (prev.length === 0) return prev;
        const idx = Math.floor(Math.random() * prev.length);
        const target = prev[idx];
        const next = nextState(target.state);
        const nextEntry: RosterEntry = {
          ...target,
          state: next,
          last_seen: next === "PRESENT" ? new Date().toISOString() : target.last_seen,
        };
        flashRef.current.set(target.student_id, Date.now());
        forceFlash((n) => n + 1);
        const copy = prev.slice();
        copy[idx] = nextEntry;
        return copy;
      });
    }, 2500);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const c = { PRESENT: 0, UNVERIFIED: 0, ABSENT: 0 } as Record<AttendanceState, number>;
    for (const r of roster) c[r.state]++;
    return c;
  }, [roster]);

  const present = counts.PRESENT;
  const total = roster.length;
  const openFlags = flags.filter((f) => f.status === "awaiting_review").length;

  const filtered = useMemo(
    () => (filter === "ALL" ? roster : roster.filter((r) => r.state === filter)),
    [roster, filter],
  );

  const decide = (id: string, status: "dismissed" | "upheld") => {
    setFlags((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  };

  const filterCount = (k: "ALL" | AttendanceState) =>
    k === "ALL" ? total : counts[k];

  return (
    <div className="space-y-8">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Present" value={present} suffix={`/ ${total}`} accent="ok" hint="Verified now" />
        <KpiCard label="Total roster" value={total} accent="primary" hint="Enrolled" />
        <KpiCard
          label="Attendance"
          value={Math.round((present / total) * 100)}
          suffix="%"
          accent="accent"
          hint="Live"
        />
        <KpiCard
          label="Open flags"
          value={openFlags}
          accent={openFlags > 0 ? "warn" : "muted"}
          hint="Awaiting review"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Roster */}
        <section className="glass-panel overflow-hidden">
          <header className="flex items-center justify-between border-b border-[color:var(--line)] px-5 py-4">
            <div>
              <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Live roster
              </div>
              <div className="mt-0.5 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                MCA-II · Distributed Systems
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
              <button className="sp-focus flex h-12 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-xs font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)]">
                <Download className="h-3.5 w-3.5" /> Export session report (PDF)
              </button>
            </div>
          </header>

          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-[color:var(--surface)] backdrop-blur">
                <tr className="border-b border-[color:var(--line)]">
                  {["", "Reg no", "Name", "State", "Last seen"].map((h) => (
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
                          {r.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-[color:var(--muted)]">{r.reg_no}</td>
                      <td className="px-4 py-3 text-[15px] text-[color:var(--ink)]">{r.name}</td>
                      <td className="px-4 py-3"><StateChip state={r.state} /></td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-[color:var(--muted)]" title={r.last_seen ?? undefined}>
                        {formatRelative(r.last_seen, now)}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
                      No rows match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Proctor review */}
        <section className="glass-panel overflow-hidden">
          <header className="flex items-center justify-between border-b border-[color:var(--line)] px-5 py-4">
            <div>
              <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Proctor review
              </div>
              <div className="mt-0.5 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                Awaiting review
              </div>
            </div>
            <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
              {openFlags} open · human decision required
            </div>
          </header>
          <div className="max-h-[560px] space-y-3 overflow-y-auto p-4">
            <AnimatePresence initial={false}>
              {flags.map((f) => (
                <motion.article
                  key={f.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className={cn(
                    "rounded-lg border p-4",
                    f.status === "awaiting_review"
                      ? "border-[color:var(--warn)]/40 bg-[color:var(--surface-2)]/60"
                      : "border-[color:var(--line)] bg-[color:var(--surface-2)]/30 opacity-60",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <FlagIcon type={f.type} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[color:var(--ink)]">
                        {flagLabel(f.type)}
                      </div>
                      <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
                        {f.session_id} · {new Date(f.ts).toLocaleTimeString()} · clip {f.clip_seconds}s
                      </div>
                    </div>
                    <span
                      className={cn(
                        "font-mono-nums text-[10px] uppercase tracking-wider",
                        f.status === "awaiting_review" && "text-[color:var(--warn)]",
                        f.status === "dismissed" && "text-[color:var(--muted)]",
                        f.status === "upheld" && "text-[color:var(--bad)]",
                      )}
                    >
                      {f.status.replace("_", " ")}
                    </span>
                  </div>
                  {f.status === "awaiting_review" && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => decide(f.id, "dismissed")}
                        className="sp-focus h-12 flex-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] text-xs font-semibold text-[color:var(--ink)] transition-colors hover:bg-[color:var(--surface)]"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => decide(f.id, "upheld")}
                        className="sp-focus h-12 flex-1 rounded-md bg-[color:var(--primary)] text-xs font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)]"
                      >
                        Uphold
                      </button>
                    </div>
                  )}
                </motion.article>
              ))}
            </AnimatePresence>
          </div>
        </section>
      </div>
    </div>
  );
}

function FlagIcon({ type }: { type: ProctorFlagType }) {
  const Icon = type === "phone" ? Phone : type === "extra_person" ? Users2 : Eye;
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] text-[color:var(--warn)]">
      <Icon className="h-4 w-4" />
    </div>
  );
}

function flagLabel(t: ProctorFlagType) {
  if (t === "phone") return "Handheld device visible";
  if (t === "extra_person") return "Additional person in frame";
  return "Sustained off-screen orientation";
}
