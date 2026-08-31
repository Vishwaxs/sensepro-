import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  Flag,
  RefreshCw,
  Smartphone,
  Users2,
  WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { fetchFlags, reviewFlag, subscribeFlags } from "@/lib/data/proctor";
import type { FlagType, ProctorFlagRow } from "@/lib/data/proctor";
import { cn } from "@/lib/utils";

const TYPE_META: Record<FlagType, { icon: typeof Flag; label: string }> = {
  phone: { icon: Smartphone, label: "Handheld device visible" },
  extra_person: { icon: Users2, label: "Additional person in frame" },
  head_pose: { icon: Eye, label: "Sustained off-screen orientation" },
  other: { icon: Flag, label: "Candidate event" },
};

function FlagIcon({ type }: { type: FlagType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[color:var(--warn)]/30 bg-[color:var(--warn)]/8 text-[color:var(--warn)]">
      <Icon className="h-4 w-4" />
    </div>
  );
}

function mergeFlags(current: ProctorFlagRow[], incoming: ProctorFlagRow[]): ProctorFlagRow[] {
  const rows = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => Date.parse(b.flagged_at) - Date.parse(a.flagged_at));
}

interface Props {
  sessionId: string | null;
  studentNames: Map<string, string>;
  onPendingCount?: (n: number) => void;
}

export function ProctorReviewPanel({ sessionId, studentNames, onPendingCount }: Props) {
  const [flags, setFlags] = useState<ProctorFlagRow[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [live, setLive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const upsert = useCallback((row: ProctorFlagRow) => {
    setFlags((current) => mergeFlags(current, [row]));
  }, []);

  useEffect(() => {
    setFlags([]);
    setLive(false);
    if (!sessionId) {
      setLoad("ready");
      return;
    }

    let cancelled = false;
    setLoad("loading");
    void fetchFlags(sessionId)
      .then((rows) => {
        if (cancelled) return;
        setFlags((current) =>
          mergeFlags(
            rows,
            current.filter((row) => row.session_id === sessionId),
          ),
        );
        setLoad("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setFlags([]);
          setLoad("error");
        }
      });

    const unsubscribe = subscribeFlags(
      sessionId,
      (row) => {
        if (row.session_id === sessionId) upsert(row);
      },
      setLive,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [revision, sessionId, upsert]);

  const pending = useMemo(() => flags.filter((flag) => flag.review_status === "pending"), [flags]);
  const reviewedCount = flags.length - pending.length;

  useEffect(() => {
    onPendingCount?.(pending.length);
  }, [pending.length, onPendingCount]);

  async function review(flag: ProctorFlagRow, status: "dismissed" | "upheld") {
    if (busyId || !sessionId) return;
    setBusyId(flag.id);
    try {
      await reviewFlag(sessionId, flag.id, status);
      upsert({ ...flag, review_status: status });
      toast.success(status === "dismissed" ? "Event dismissed" : "Follow-up requested");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review decision was not saved");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass-panel overflow-hidden">
      <header className="flex flex-col gap-3 border-b border-[color:var(--line)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--warn)]">
            Exam event review
          </div>
          <div className="mt-0.5 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
            Awaiting teacher decision
          </div>
          <p className="mt-1 text-xs text-[color:var(--muted)]">
            Candidate events only. No event creates an automatic misconduct verdict.
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-1">
          <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
            <span className="text-base font-bold text-[color:var(--ink)]">{pending.length}</span>{" "}
            open
          </div>
          {sessionId && live ? (
            <span className="flex items-center gap-1.5 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--ok)]">
              <span className="h-2 w-2 rounded-full bg-[color:var(--ok)]" /> queue connected
            </span>
          ) : sessionId ? (
            <span className="flex items-center gap-1.5 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--warn)]">
              <WifiOff className="h-3 w-3" /> queue reconnecting
            </span>
          ) : null}
        </div>
      </header>

      {!sessionId ? (
        <EmptyState
          icon={Flag}
          title="No examination selected"
          detail="Open an examination session to load its human-review queue."
        />
      ) : load === "loading" ? (
        <div className="grid min-h-48 place-items-center px-5 py-8 font-mono-nums text-xs text-[color:var(--muted)]">
          Loading retained examination events…
        </div>
      ) : load === "error" ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-5 py-10 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load this review queue
          </div>
          <p className="max-w-md text-sm">
            Retained results stay hidden until this exact examination refreshes successfully.
          </p>
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
            className="sp-btn sp-btn-secondary min-h-11"
          >
            <RefreshCw className="h-4 w-4" /> Retry queue
          </button>
        </div>
      ) : pending.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Review queue clear"
          detail={
            reviewedCount > 0
              ? `${reviewedCount} decision${reviewedCount === 1 ? " is" : "s are"} available in review history.`
              : "No candidate events have been retained for this examination."
          }
        />
      ) : (
        <div className="max-h-[560px] space-y-3 overflow-y-auto p-4">
          <AnimatePresence initial={false}>
            {pending.map((flag) => {
              const candidate = flag.student_id
                ? (studentNames.get(flag.student_id) ?? "Unresolved candidate record")
                : "Unattributed track";
              return (
                <motion.article
                  key={flag.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="rounded-lg border border-[color:var(--warn)]/30 bg-[color:var(--surface-2)]/60 p-4"
                >
                  <div className="flex items-start gap-3">
                    <FlagIcon type={flag.flag_type} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[color:var(--ink)]">{candidate}</div>
                      <div className="mt-0.5 text-sm text-[color:var(--muted)]">
                        {TYPE_META[flag.flag_type].label}
                      </div>
                      <time
                        dateTime={flag.flagged_at}
                        className="mt-1.5 block font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]"
                      >
                        {new Date(flag.flagged_at).toLocaleString()}
                      </time>
                    </div>
                    <span className="rounded-md border border-[color:var(--warn)]/30 bg-[color:var(--warn)]/8 px-2 py-1 font-mono-nums text-[9px] uppercase tracking-wider text-[color:var(--warn)]">
                      Awaiting review
                    </span>
                  </div>

                  <p className="mt-3 border-t border-[color:var(--line)]/70 pt-3 text-xs leading-relaxed text-[color:var(--muted)]">
                    Frame content is not retained. Decide from the event time, live supervision, and
                    examination context.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => void review(flag, "dismissed")}
                      disabled={busyId !== null}
                      className="sp-btn sp-btn-secondary min-h-11 flex-1 disabled:cursor-wait disabled:opacity-60"
                    >
                      Dismiss event
                    </button>
                    <button
                      type="button"
                      onClick={() => void review(flag, "upheld")}
                      disabled={busyId !== null}
                      className="sp-btn sp-btn-destructive min-h-11 flex-1 disabled:cursor-wait disabled:opacity-60"
                    >
                      Retain for follow-up
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {sessionId ? (
        <footer className="flex flex-col gap-2 border-t border-[color:var(--line)] bg-[color:var(--surface-2)]/30 px-5 py-3 text-xs text-[color:var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>
            {reviewedCount} reviewed decision{reviewedCount === 1 ? "" : "s"}
          </span>
          <Link
            to="/proctor"
            search={{ session_id: sessionId }}
            className="sp-focus inline-flex min-h-10 items-center gap-2 rounded-md px-2 font-semibold text-[color:var(--primary)] hover:text-[color:var(--primary-deep)]"
          >
            Open full review history <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </footer>
      ) : null}
    </section>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Flag;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-5 py-10 text-center text-[color:var(--muted)]">
      <Icon
        className={cn("h-8 w-8 opacity-60", Icon === CheckCircle2 && "text-[color:var(--ok)]")}
      />
      <div className="mt-3 font-display text-lg font-medium text-[color:var(--ink)]">{title}</div>
      <p className="mt-1 max-w-md text-sm">{detail}</p>
    </div>
  );
}
