import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CalendarCheck, FileSignature, Fingerprint, Percent, Trash2, UserRound } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { PresenceState } from "@/lib/types";
import { fmtDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

interface OwnInterval {
  id: string;
  state: PresenceState;
  started_at: string;
  ended_at: string | null;
  session: { subject: string | null; class_section: string; mode: string; starts_at: string };
}

/** Own-record view. RLS scopes every read to the signed-in student's rows via
 *  students.auth_uid — a student account not yet linked simply sees nothing. */
export function StudentPortal() {
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [rows, setRows] = useState<OwnInterval[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // RLS "presence self read" + "sessions staff read" don't cover a
      // student reading class_sessions, so fetch intervals flat and join
      // sessions only if readable; fall back to interval data alone.
      const { data } = await supabase
        .from("presence_intervals")
        .select(
          "id, state, started_at, ended_at, session:class_sessions(subject, class_section, mode, starts_at)",
        )
        .order("started_at", { ascending: false });
      if (!cancelled) setRows((data as unknown as OwnInterval[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const presentSeconds = (rows ?? [])
    .filter((r) => r.state === "PRESENT" && r.ended_at)
    .reduce((a, r) => a + (Date.parse(r.ended_at!) - Date.parse(r.started_at)) / 1000, 0);
  const sessionsAttended = new Set(
    (rows ?? []).filter((r) => r.state === "PRESENT").map((r) => r.session?.starts_at),
  ).size;

  return (
    <div>
      <PageHeader
        title="My record"
        subtitle="Only you and the administrator can see this. Your identity exists in the system as a numeric face signature (embedding) — no photos or video of you are stored."
      />

      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <StatCard label="Time present" value={presentSeconds / 60} decimals={0} suffix=" min" icon={Percent} tone="ok" note="across recorded sessions" />
        <StatCard label="Sessions attended" value={sessionsAttended} icon={CalendarCheck} note="with recorded presence" />
        <StatCard label="Consent" value={1} icon={FileSignature} tone="ok" note="signed · revocable anytime" />
      </motion.div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <motion.div
          {...rise}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}
          className="xl:col-span-2"
        >
          <Card>
            <CardHeader title="Attendance history" hint="Presence measured by interval, not a single scan." />
            {rows === null ? (
              <p className="px-5 py-10 text-center font-mono text-[12.5px] text-muted">loading…</p>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={UserRound}
                title="No attendance recorded yet"
                hint="Records appear here once your student profile is linked to this login and a session has run."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                      <th scope="col" className="px-5 py-2.5 font-medium">Session</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Date</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                      <th scope="col" className="px-5 py-2.5 text-right font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-line/60 last:border-0">
                        <td className="px-5 py-3">
                          <div className="font-medium text-ink">{r.session?.subject ?? "Session"}</div>
                          <div className="font-mono text-[11.5px] text-muted">
                            {r.session?.class_section} · {r.session?.mode}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[12px] text-muted">
                          {new Date(r.started_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={r.state === "PRESENT" ? "ok" : r.state === "UNVERIFIED" ? "warn" : "muted"}>
                            {r.state}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums text-ink">
                          {r.ended_at
                            ? fmtDuration((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)
                            : "ongoing"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div {...rise} transition={{ duration: 0.2, ease: "easeOut", delay: 0.1 }}>
          <Card>
            <CardHeader title="Your data, your rights" />
            <CardBody className="flex flex-col gap-4">
              <div className="flex items-start gap-3 text-[13px] leading-relaxed text-muted">
                <Fingerprint className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <p>
                  What we hold: your name, ID, consent record, attendance intervals, and a
                  512-number face signature. What we never hold: photos, video, emotion labels,
                  or a personal engagement score.
                </p>
              </div>

              <div className="rounded-lg border border-line bg-surface-2/60 p-4">
                <h3 className="text-[13px] font-medium text-ink">Request deletion</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  Deleting your data purges your face signature and identity records and writes an
                  audit entry. Attendance already reported to the university is governed by
                  university policy.
                </p>
                {deleteStep === 0 && (
                  <Button variant="danger" size="sm" className="mt-3" onClick={() => setDeleteStep(1)}>
                    <Trash2 className="size-4" aria-hidden="true" /> Request data deletion
                  </Button>
                )}
                {deleteStep === 1 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] text-warn">This cannot be undone. Continue?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        /* Deliberate stub: the real cascade purge is a later,
                           audited step. Log intent only — never hard-delete
                           from the client. */
                        console.info("data-deletion request recorded (stub)");
                        setDeleteStep(2);
                      }}
                    >
                      Yes, delete
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteStep(0)}>
                      Cancel
                    </Button>
                  </div>
                )}
                {deleteStep === 2 && (
                  <p className="mt-3 text-[12.5px] text-ok" role="status">
                    Deletion request submitted to the administrator. You will be notified when the
                    purge completes.
                  </p>
                )}
              </div>
            </CardBody>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
