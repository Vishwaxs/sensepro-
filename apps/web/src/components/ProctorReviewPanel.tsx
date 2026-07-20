import { useCallback, useEffect, useState } from "react";
import { Flag, ScanFace, Smartphone, UsersRound, WifiOff } from "lucide-react";
import { fetchFlags, reviewFlag, subscribeFlags } from "@/lib/data/proctor";
import type { FlagType, ProctorFlagRow } from "@/lib/data/proctor";
import { useAuth } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { LiveDot } from "@/components/LiveDot";

/** The human review queue. Every flag arrives "awaiting review" and only a
 *  person moves it to dismissed or upheld — there is no auto-penalty path in
 *  this system, and none of the copy below implies guilt. */

const TYPE_META: Record<FlagType, { icon: typeof Flag; label: string }> = {
  phone: { icon: Smartphone, label: "Possible phone" },
  extra_person: { icon: UsersRound, label: "Extra person in frame" },
  head_pose: { icon: ScanFace, label: "Head-pose event" },
  other: { icon: Flag, label: "Flagged event" },
};

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface Props {
  sessionId: string | null;
  /** students.id -> full name, for attributing a flag to a display name */
  studentNames: Map<string, string>;
  onPendingCount?: (n: number) => void;
}

export function ProctorReviewPanel({ sessionId, studentNames, onPendingCount }: Props) {
  const { user } = useAuth();
  const [flags, setFlags] = useState<ProctorFlagRow[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [live, setLive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const upsert = useCallback((row: ProctorFlagRow) => {
    setFlags((prev) => {
      const next = prev.filter((f) => f.id !== row.id);
      next.push(row);
      next.sort((a, b) => Date.parse(b.flagged_at) - Date.parse(a.flagged_at));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setFlags([]);
      setLoad("ready");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchFlags(sessionId);
        if (!cancelled) {
          setFlags(rows);
          setLoad("ready");
        }
      } catch {
        if (!cancelled) setLoad("error");
      }
    })();
    const unsubscribe = subscribeFlags(sessionId, upsert, setLive);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, upsert]);

  const pending = flags.filter((f) => f.review_status === "pending");
  useEffect(() => {
    onPendingCount?.(pending.length);
  }, [pending.length, onPendingCount]);

  const review = async (flag: ProctorFlagRow, status: "dismissed" | "upheld") => {
    if (!user) return;
    setBusyId(flag.id);
    const before = flag;
    upsert({ ...flag, review_status: status, reviewed_by: user.id }); // optimistic
    try {
      await reviewFlag(flag.id, status, user.id);
    } catch {
      upsert(before); // revert — the row stays awaiting review
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader
        title="Proctor review"
        hint="Candidate events from exam mode. A human decides every one — nothing is auto-penalised."
        action={
          sessionId ? (
            live ? (
              <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted">
                <LiveDot /> live
              </div>
            ) : (
              <div className="flex items-center gap-2 font-mono text-[11.5px] text-warn">
                <WifiOff className="size-3.5" aria-hidden="true" /> reconnecting
              </div>
            )
          ) : null
        }
      />
      {load === "loading" ? (
        <p className="px-5 py-8 text-center font-mono text-[12.5px] text-muted">loading queue…</p>
      ) : load === "error" ? (
        <EmptyState
          icon={WifiOff}
          title="Could not load the review queue"
          hint="Check your connection and role, then reload."
        />
      ) : flags.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No flags in this session"
          hint="Exam-mode capture raises candidate events here for human review."
        />
      ) : (
        <ul className="divide-y divide-line/60">
          {flags.map((f) => {
            const meta = TYPE_META[f.flag_type];
            const who = f.student_id ? (studentNames.get(f.student_id) ?? "Unknown student") : null;
            return (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <meta.icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-ink">
                    {meta.label}
                    {who ? <span className="text-muted"> · near {who}</span> : null}
                  </p>
                  <p className="font-mono text-[11.5px] text-muted">{timeOf(f.flagged_at)}</p>
                </div>
                {f.review_status === "pending" ? (
                  <>
                    <Badge tone="warn">Awaiting review</Badge>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => void review(f, "dismissed")}
                        disabled={busyId === f.id}
                      >
                        Dismiss
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void review(f, "upheld")}
                        disabled={busyId === f.id}
                      >
                        Uphold
                      </Button>
                    </div>
                  </>
                ) : f.review_status === "dismissed" ? (
                  <Badge tone="muted">Dismissed</Badge>
                ) : (
                  <Badge tone="bad">Upheld</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
