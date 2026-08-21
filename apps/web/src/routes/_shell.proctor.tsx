import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, Check, X, ChevronRight, AlertTriangle, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { guardRoute } from "@/lib/auth-guard";
import { fetchStudents } from "@/lib/data/roster";
import { fetchExamSessions, fetchFlags, reviewFlag, subscribeFlags } from "@/lib/data/proctor";
import type { ExamSessionRow, ProctorFlagRow, FlagType } from "@/lib/data/proctor";

export const Route = createFileRoute("/_shell/proctor")({
  beforeLoad: guardRoute(["teacher"]),
  validateSearch: (search: Record<string, unknown>) => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  head: () => ({
    meta: [{ title: "Proctor Queue · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: ProctorPage,
});

const TYPE_LABELS: Record<FlagType, string> = {
  phone: "Handheld device visible",
  extra_person: "Additional person in frame",
  head_pose: "Sustained off-screen head pose",
  other: "Candidate event",
};

function ProctorPage() {
  const { session_id: requestedSessionId } = Route.useSearch();
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [sessions, setSessions] = useState<ExamSessionRow[]>([]);
  const [session, setSession] = useState<ExamSessionRow | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [flags, setFlags] = useState<ProctorFlagRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [examSessions, students] = await Promise.all([fetchExamSessions(), fetchStudents()]);
        if (!mounted) return;
        setSessions(examSessions);
        setSession(
          examSessions.find((row) => row.id === requestedSessionId) ??
            examSessions.find((row) => row.ends_at === null) ??
            examSessions[0] ??
            null,
        );
        setNames(new Map(students.map((s) => [s.id, s.full_name])));
        setLoad("ready");
      } catch {
        if (mounted) setLoad("error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [requestedSessionId]);

  useEffect(() => {
    if (!session) {
      setFlags([]);
      return;
    }
    let cancelled = false;
    setLoad("loading");
    fetchFlags(session.id)
      .then((rows) => {
        if (!cancelled) {
          setFlags(rows);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setLoad("error");
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return subscribeFlags(session.id, (row) => {
      setFlags((prev) => {
        const i = prev.findIndex((f) => f.id === row.id);
        if (i === -1) return [row, ...prev];
        const next = prev.slice();
        next[i] = row;
        return next;
      });
    });
  }, [session]);

  const pending = useMemo(() => flags.filter((f) => f.review_status === "pending"), [flags]);
  const current = flags.find((f) => f.id === selected) ?? pending[0];

  async function resolve(id: string, verdict: "dismissed" | "upheld") {
    try {
      await reviewFlag(id, verdict);
      setFlags((prev) => prev.map((f) => (f.id === id ? { ...f, review_status: verdict } : f)));
      if (selected === id) setSelected(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Examination · human-in-the-loop
          </div>
          <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
            Proctor review queue
          </h2>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Every event requires human review. The system flags — you decide. No automated verdicts.
          </p>
        </div>
        {sessions.length > 0 && (
          <label className="grid gap-1 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
            Exam session
            <select
              value={session?.id ?? ""}
              onChange={(event) =>
                setSession(sessions.find((row) => row.id === event.target.value) ?? null)
              }
              className="sp-focus h-12 min-w-64 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 text-xs normal-case tracking-normal text-[color:var(--ink)]"
            >
              {sessions.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.subject ?? row.class_section} · {row.ends_at ? "completed" : "live"}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {load === "loading" ? (
        <div className="glass-panel grid h-56 place-items-center font-mono text-[12.5px] text-[color:var(--muted)]">
          loading…
        </div>
      ) : load === "error" ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load the proctor queue
          </div>
          <p className="text-sm">Check your connection and role, then refresh.</p>
        </div>
      ) : !session ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
          <ShieldAlert className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            No examination session
          </div>
          <p className="text-sm">Start an exam from Capture to begin the review record.</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* Flag list */}
          <div className="glass-panel overflow-hidden">
            <div className="border-b border-[color:var(--line)] px-4 py-3">
              <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                {pending.length} pending review
              </div>
            </div>
            <div className="max-h-[65vh] overflow-y-auto">
              <AnimatePresence>
                {pending.map((f) => (
                    <motion.button
                      key={f.id}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20, height: 0 }}
                      onClick={() => setSelected(f.id)}
                      className={`sp-focus w-full border-b border-[color:var(--line)]/50 px-4 py-3 text-left transition-colors ${
                        current?.id === f.id
                          ? "bg-[color:var(--surface-2)]"
                          : "hover:bg-[color:var(--surface-2)]/50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm font-medium text-[color:var(--ink)]">
                          <ShieldAlert className="h-3.5 w-3.5 text-[color:var(--warn)]" />
                          {f.student_id
                            ? (names.get(f.student_id) ?? "Unknown student")
                            : "Unattributed"}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 text-[color:var(--muted)]" />
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-[color:var(--muted)]">
                        <span className="font-mono-nums">
                          {new Date(f.flagged_at).toLocaleTimeString()}
                        </span>
                        <span>·</span>
                        <span>{TYPE_LABELS[f.flag_type]}</span>
                      </div>
                      <div className="mt-1.5">
                        <span className="inline-flex items-center rounded-full border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--warn)]">
                          review event
                        </span>
                      </div>
                    </motion.button>
                  ))}
              </AnimatePresence>
              {pending.length === 0 && (
                <div className="px-4 py-12 text-center">
                  <Check className="mx-auto h-8 w-8 text-[color:var(--ok)]" />
                  <p className="mt-2 text-sm text-[color:var(--muted)]">All flags reviewed</p>
                </div>
              )}
            </div>
          </div>

          {/* Detail panel */}
          <div className="glass-panel p-6">
            {current ? (
              <div>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                      {current.id.slice(0, 8)}
                    </div>
                    <h3 className="mt-1 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                      {TYPE_LABELS[current.flag_type]}
                    </h3>
                    <p className="mt-1 text-sm text-[color:var(--muted)]">
                      Flagged for{" "}
                      {current.student_id
                        ? (names.get(current.student_id) ?? "Unknown student")
                        : "an unattributed track"}{" "}
                      at {new Date(current.flagged_at).toLocaleTimeString()}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-2.5 py-1 font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--warn)]">
                    awaiting review
                  </span>
                </div>

                <div className="mt-6 grid place-items-center rounded-xl border border-dashed border-[color:var(--line)]/70 bg-[color:var(--surface)]/50 py-20">
                  <AlertTriangle className="h-8 w-8 text-[color:var(--warn)]" />
                  <p className="mt-2 max-w-xs text-center font-mono-nums text-[11px] text-[color:var(--muted)]">
                    No image is stored for this flag — frames are processed in memory and never
                    persisted, so there is nothing to show here by design.
                  </p>
                </div>

                <div className="mt-4 rounded-md border border-[color:var(--warn)]/30 bg-[color:var(--warn)]/5 p-3 text-xs text-[color:var(--warn)]">
                  <strong>Reminder:</strong> This flag is a suggestion, not a verdict. Only you can
                  escalate or dismiss.
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={() => void resolve(current.id, "dismissed")}
                    className="sp-btn sp-btn-secondary"
                  >
                    <X className="h-4 w-4" /> Dismiss
                  </button>
                  <button
                    onClick={() => void resolve(current.id, "upheld")}
                    className="sp-btn sp-btn-destructive"
                  >
                    <ShieldAlert className="h-4 w-4" /> Uphold flag
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[300px] items-center justify-center text-center">
                <div>
                  <Check className="mx-auto h-10 w-10 text-[color:var(--ok)]" />
                  <p className="mt-3 text-sm text-[color:var(--muted)]">Select a flag to review</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
