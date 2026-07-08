import { useState } from "react";
import { motion } from "framer-motion";
import { CalendarCheck, FileSignature, Fingerprint, Percent, Trash2 } from "lucide-react";
import { mockSessions } from "@/lib/mock";
import { fmtDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

/** Own-record view for the signed-in student (RLS scopes reads server-side). */
const myAttendance = [
  { session: mockSessions[0], present_seconds: 2640, state: "PRESENT" as const },
  { session: mockSessions[1], present_seconds: 3120, state: "PRESENT" as const },
  { session: mockSessions[2], present_seconds: 6890, state: "PRESENT" as const },
];

export function StudentPortal() {
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);

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
        <StatCard label="Attendance" value={94} suffix="%" icon={Percent} tone="ok" note="this semester" />
        <StatCard label="Sessions attended" value={myAttendance.length} icon={CalendarCheck} note="of 3 held" />
        <StatCard label="Consent" value={1} icon={FileSignature} tone="ok" note="signed 24 Jun 2026 · revocable anytime" />
      </motion.div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <motion.div
          {...rise}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}
          className="xl:col-span-2"
        >
          <Card>
            <CardHeader title="Attendance history" hint="Presence measured by interval, not a single scan." />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Session</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Date</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Result</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">Time present</th>
                  </tr>
                </thead>
                <tbody>
                  {myAttendance.map(({ session, present_seconds }) => (
                    <tr key={session.session_id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3">
                        <div className="font-medium text-ink">{session.subject}</div>
                        <div className="font-mono text-[11.5px] text-muted">
                          {session.class_section} · {session.mode}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px] text-muted">
                        {new Date(session.started_at).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone="ok">PRESENT</Badge>
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-ink">
                        {fmtDuration(present_seconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                    <Button variant="danger" size="sm" onClick={() => setDeleteStep(2)}>
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
