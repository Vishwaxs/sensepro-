import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  EyeOff,
  RefreshCw,
  ShieldAlert,
  UserRoundSearch,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { guardRoute } from "@/lib/auth-guard";
import { fetchStudents } from "@/lib/data/roster";
import {
  fetchExamSession,
  fetchExamSessions,
  fetchFlags,
  reviewFlag,
  subscribeFlags,
} from "@/lib/data/proctor";
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

const STATUS_LABELS: Record<ProctorFlagRow["review_status"], string> = {
  pending: "Awaiting review",
  dismissed: "Dismissed",
  upheld: "Follow-up requested",
};

function formatSessionOption(row: ExamSessionRow): string {
  const subject = row.subject ?? "Examination";
  const started = new Date(row.starts_at).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${subject} · ${row.class_section} · ${started} · ${row.ends_at ? "completed" : "live"}`;
}

function candidateLabel(flag: ProctorFlagRow, names: Map<string, string>): string {
  if (!flag.student_id) return "Unattributed track";
  return names.get(flag.student_id) ?? "Unresolved candidate record";
}

function ProctorPage() {
  const { session_id: requestedSessionId } = Route.useSearch();
  const [pageLoad, setPageLoad] = useState<"loading" | "ready" | "error">("loading");
  const [queueLoad, setQueueLoad] = useState<"loading" | "ready" | "error">("loading");
  const [sessions, setSessions] = useState<ExamSessionRow[]>([]);
  const [session, setSession] = useState<ExamSessionRow | null>(null);
  const [requestedMissing, setRequestedMissing] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [flags, setFlags] = useState<ProctorFlagRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"pending" | "reviewed">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pageRevision, setPageRevision] = useState(0);
  const [queueRevision, setQueueRevision] = useState(0);

  useEffect(() => {
    let mounted = true;
    setPageLoad("loading");
    (async () => {
      try {
        const [examSessions, requestedSession, students] = await Promise.all([
          fetchExamSessions(),
          requestedSessionId ? fetchExamSession(requestedSessionId) : Promise.resolve(null),
          fetchStudents(),
        ]);
        if (!mounted) return;
        const listedSessions =
          requestedSession && !examSessions.some((row) => row.id === requestedSession.id)
            ? [requestedSession, ...examSessions]
            : examSessions;
        setSessions(listedSessions);
        setRequestedMissing(!!requestedSessionId && !requestedSession);
        setSession(
          requestedSessionId
            ? requestedSession
            : (listedSessions.find((row) => row.ends_at === null) ?? listedSessions[0] ?? null),
        );
        setNames(new Map(students.map((s) => [s.id, s.full_name])));
        setPageLoad("ready");
      } catch {
        if (mounted) setPageLoad("error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [pageRevision, requestedSessionId]);

  useEffect(() => {
    if (!session) {
      setFlags([]);
      setQueueLoad("ready");
      return;
    }
    let cancelled = false;
    setSelected(null);
    setQueueLoad("loading");
    fetchFlags(session.id)
      .then((rows) => {
        if (!cancelled) {
          setFlags(rows);
          setQueueLoad("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setQueueLoad("error");
      });
    return () => {
      cancelled = true;
    };
  }, [queueRevision, session]);

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
  const reviewed = useMemo(() => flags.filter((f) => f.review_status !== "pending"), [flags]);
  const visibleFlags = view === "pending" ? pending : reviewed;
  const current = visibleFlags.find((f) => f.id === selected) ?? visibleFlags[0];

  async function resolve(id: string, verdict: "dismissed" | "upheld") {
    if (busyId) return;
    setBusyId(id);
    try {
      if (!session) throw new Error("No examination session is selected");
      await reviewFlag(session.id, id, verdict);
      setFlags((prev) => prev.map((f) => (f.id === id ? { ...f, review_status: verdict } : f)));
      if (selected === id) setSelected(null);
      toast.success(verdict === "dismissed" ? "Event dismissed" : "Follow-up requested");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--warn)]">
            Examination · human review
          </div>
          <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
            Proctor event desk
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Device, additional-person, and sustained head-pose events require a teacher decision. No
            event creates an automatic misconduct verdict or penalty.
          </p>
        </div>
        {pageLoad === "ready" && sessions.length > 0 ? (
          <label className="grid w-full gap-1 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)] sm:w-auto">
            Exam session
            <select
              value={session?.id ?? ""}
              onChange={(event) => {
                setView("pending");
                setSession(sessions.find((row) => row.id === event.target.value) ?? null);
              }}
              className="sp-focus h-12 w-full min-w-0 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 text-xs normal-case tracking-normal text-[color:var(--ink)] sm:max-w-[460px]"
            >
              {sessions.map((row) => (
                <option key={row.id} value={row.id}>
                  {formatSessionOption(row)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {pageLoad === "loading" ? (
        <div className="glass-panel grid h-56 place-items-center font-mono-nums text-xs text-[color:var(--muted)]">
          Loading examination sessions…
        </div>
      ) : pageLoad === "error" ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-3 py-16 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load examination sessions
          </div>
          <p className="text-sm">No different examination was substituted.</p>
          <button
            type="button"
            onClick={() => setPageRevision((revision) => revision + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : !session ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
          <ShieldAlert className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            {requestedMissing ? "Examination session not found" : "No examination session"}
          </div>
          <p className="max-w-lg text-sm">
            {requestedMissing
              ? "The requested record is unavailable or is not an examination session. No other exam was substituted."
              : "Start an exam from Capture to create a proctor review record."}
          </p>
        </div>
      ) : queueLoad === "loading" ? (
        <div className="glass-panel grid h-56 place-items-center font-mono-nums text-xs text-[color:var(--muted)]">
          Loading proctor events…
        </div>
      ) : queueLoad === "error" ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-3 py-16 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load this examination queue
          </div>
          <p className="text-sm">Retained events are hidden until this session refreshes.</p>
          <button
            type="button"
            onClick={() => setQueueRevision((revision) => revision + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            <RefreshCw className="h-4 w-4" /> Retry queue
          </button>
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="glass-panel min-w-0 overflow-hidden">
            <div className="border-b border-[color:var(--line)] p-3">
              <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Proctor events">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "pending"}
                  onClick={() => {
                    setView("pending");
                    setSelected(null);
                  }}
                  className={`sp-focus min-h-11 rounded-md border px-3 font-mono-nums text-[11px] uppercase tracking-wider transition-colors ${
                    view === "pending"
                      ? "border-[color:var(--warn)]/50 bg-[color:var(--warn)]/10 text-[color:var(--warn)]"
                      : "border-[color:var(--line)] text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                  }`}
                >
                  Awaiting · {pending.length}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "reviewed"}
                  onClick={() => {
                    setView("reviewed");
                    setSelected(null);
                  }}
                  className={`sp-focus min-h-11 rounded-md border px-3 font-mono-nums text-[11px] uppercase tracking-wider transition-colors ${
                    view === "reviewed"
                      ? "border-[color:var(--primary)]/50 bg-[color:var(--primary)]/10 text-[color:var(--primary)]"
                      : "border-[color:var(--line)] text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                  }`}
                >
                  Reviewed · {reviewed.length}
                </button>
              </div>
            </div>

            <div className="max-h-[55vh] overflow-y-auto xl:max-h-[68vh]" role="tabpanel">
              {visibleFlags.map((flag) => (
                <button
                  key={flag.id}
                  type="button"
                  onClick={() => setSelected(flag.id)}
                  className={`sp-focus w-full border-b border-[color:var(--line)]/50 px-4 py-3 text-left transition-colors ${
                    current?.id === flag.id
                      ? "bg-[color:var(--surface-2)]"
                      : "hover:bg-[color:var(--surface-2)]/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-[color:var(--ink)]">
                      <ShieldAlert
                        className={`h-3.5 w-3.5 shrink-0 ${
                          flag.review_status === "pending"
                            ? "text-[color:var(--warn)]"
                            : "text-[color:var(--muted)]"
                        }`}
                      />
                      <span className="truncate">{candidateLabel(flag, names)}</span>
                    </span>
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--muted)]" />
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--muted)]">
                    {TYPE_LABELS[flag.flag_type]}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                    <time dateTime={flag.flagged_at}>
                      {new Date(flag.flagged_at).toLocaleTimeString()}
                    </time>
                    <span
                      className={
                        flag.review_status === "pending"
                          ? "text-[color:var(--warn)]"
                          : flag.review_status === "upheld"
                            ? "text-[color:var(--bad)]"
                            : "text-[color:var(--ok)]"
                      }
                    >
                      {STATUS_LABELS[flag.review_status]}
                    </span>
                  </div>
                </button>
              ))}

              {visibleFlags.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <Check className="mx-auto h-8 w-8 text-[color:var(--ok)]" />
                  <p className="mt-2 text-sm text-[color:var(--muted)]">
                    {view === "pending"
                      ? "No events are awaiting review"
                      : "No review decisions recorded"}
                  </p>
                </div>
              ) : null}
            </div>
          </aside>

          <section className="glass-panel min-w-0 p-5 sm:p-6">
            {current ? (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                      Event {current.id.slice(0, 8)}
                    </div>
                    <h3 className="mt-1 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                      {TYPE_LABELS[current.flag_type]}
                    </h3>
                    <p className="mt-1 text-sm text-[color:var(--muted)]">
                      Candidate event metadata for teacher review.
                    </p>
                  </div>
                  <span
                    className={`inline-flex min-h-8 items-center rounded-md border px-2.5 py-1 font-mono-nums text-[10px] uppercase tracking-[0.16em] ${
                      current.review_status === "pending"
                        ? "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]"
                        : current.review_status === "upheld"
                          ? "border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 text-[color:var(--bad)]"
                          : "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]"
                    }`}
                  >
                    {STATUS_LABELS[current.review_status]}
                  </span>
                </div>

                <dl className="mt-6 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-4">
                    <dt className="flex items-center gap-2 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                      <UserRoundSearch className="h-4 w-4" /> Candidate attribution
                    </dt>
                    <dd className="mt-2 text-sm font-medium text-[color:var(--ink)]">
                      {candidateLabel(current, names)}
                    </dd>
                  </div>
                  <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-4">
                    <dt className="flex items-center gap-2 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                      <Clock3 className="h-4 w-4" /> Detected
                    </dt>
                    <dd className="mt-2 text-sm font-medium text-[color:var(--ink)]">
                      <time dateTime={current.flagged_at}>
                        {new Date(current.flagged_at).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] p-4">
                  <div className="flex items-start gap-3">
                    <EyeOff className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" />
                    <div>
                      <h4 className="text-sm font-semibold text-[color:var(--ink)]">
                        Event metadata only
                      </h4>
                      <p className="mt-1 text-sm leading-relaxed text-[color:var(--muted)]">
                        Camera frames are processed in memory and discarded. Use the event time,
                        live supervision, and exam context when reviewing; this record alone does
                        not prove misconduct.
                      </p>
                    </div>
                  </div>
                </div>

                {current.review_status === "pending" ? (
                  <div className="mt-6 rounded-md border border-[color:var(--warn)]/30 bg-[color:var(--warn)]/5 p-4">
                    <p className="text-xs leading-relaxed text-[color:var(--warn)]">
                      A review decision records how this event should be handled. It does not apply
                      a penalty automatically.
                    </p>
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void resolve(current.id, "dismissed")}
                        disabled={busyId !== null}
                        className="sp-btn sp-btn-secondary min-h-11 disabled:cursor-wait disabled:opacity-60"
                      >
                        <X className="h-4 w-4" /> Dismiss event
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(current.id, "upheld")}
                        disabled={busyId !== null}
                        className="sp-btn sp-btn-destructive min-h-11 disabled:cursor-wait disabled:opacity-60"
                      >
                        <ShieldAlert className="h-4 w-4" /> Retain for follow-up
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-4 text-sm text-[color:var(--muted)]">
                    Decision recorded as {STATUS_LABELS[current.review_status].toLowerCase()}
                    {current.reviewed_at
                      ? ` on ${new Date(current.reviewed_at).toLocaleString()}`
                      : ""}
                    . This review outcome is not an automatic penalty.
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-full min-h-[320px] items-center justify-center text-center">
                <div>
                  <Check className="mx-auto h-10 w-10 text-[color:var(--ok)]" />
                  <p className="mt-3 text-sm text-[color:var(--muted)]">
                    {view === "pending"
                      ? "No event is awaiting review"
                      : "No reviewed event selected"}
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
