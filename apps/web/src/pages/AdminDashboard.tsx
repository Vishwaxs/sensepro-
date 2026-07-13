import { motion } from "framer-motion";
import { FileSignature, Link2, MonitorSmartphone, UsersRound } from "lucide-react";
import { mockAudit, mockCaptureClients, mockConsent, mockUsers } from "@/lib/mock";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { LiveDot } from "@/components/LiveDot";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function AdminDashboard() {
  const signed = mockConsent.filter((c) => c.signed).length;
  const online = mockCaptureClients.filter((d) => d.status === "online").length;

  return (
    <div>
      <PageHeader
        title="Administration"
        subtitle="Capture clients, users, the consent registry and the audit chain."
      />

      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard label="Capture clients" value={mockCaptureClients.length} icon={MonitorSmartphone} note={`${online} online now`} />
        <StatCard label="Users" value={mockUsers.length} icon={UsersRound} note="teacher · management · admin" />
        <StatCard label="Consent signed" value={signed} icon={FileSignature} tone="ok" note={`of ${mockConsent.length} enrolled students`} />
        <StatCard label="Audit chain" value={mockAudit[0]?.seq ?? 0} icon={Link2} note="entries, hash-chained" />
      </motion.div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <motion.div {...rise} transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}>
          <Card>
            <CardHeader
              title="Capture clients"
              hint="Browsers that stream classroom frames — devices are just capture clients."
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Client</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Room</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {mockCaptureClients.map((d) => (
                    <tr key={d.device_id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3">
                        <div className="font-medium text-ink">{d.label}</div>
                        <div className="font-mono text-[11.5px] text-muted">{d.device_id}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-muted">{d.room}</td>
                      <td className="px-4 py-3">
                        {d.status === "online" ? (
                          <Badge tone="ok">
                            <LiveDot tone="ok" /> online
                          </Badge>
                        ) : (
                          <Badge tone="muted">offline</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3 font-mono text-[12px] text-muted">
                        {new Date(d.last_seen).toLocaleString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="mt-6">
            <CardHeader title="Users" hint="Roles are enforced by database row-level security." />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Username</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {mockUsers.map((u) => (
                    <tr key={u.user} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3 font-medium text-ink">{u.name}</td>
                      <td className="px-4 py-3 font-mono text-muted">{u.user}</td>
                      <td className="px-5 py-3">
                        <Badge tone={u.role === "management" ? "accent" : "muted"}>{u.role}</Badge>
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
            <CardHeader
              title="Consent registry"
              hint="Recognition never runs for a student without a signed consent record."
            />
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-t border-b border-line font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Student</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Consent</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Signed on</th>
                  </tr>
                </thead>
                <tbody>
                  {mockConsent.map((c) => (
                    <tr key={c.student_id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-2.5">
                        <span className="font-medium text-ink">{c.name}</span>
                        <span className="ml-2 font-mono text-[11.5px] text-muted">{c.student_id}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {c.signed ? <Badge tone="ok">signed</Badge> : <Badge tone="warn">pending</Badge>}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-[12px] text-muted">{c.signed_on ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="mt-6">
            <CardHeader
              title="Audit chain"
              hint="Every attendance-affecting write appends a hash-chained entry."
              action={<Badge tone="ok">chain verified</Badge>}
            />
            <CardBody className="pt-1">
              <ol className="flex flex-col">
                {mockAudit.map((a) => (
                  <li
                    key={a.seq}
                    className="flex items-baseline justify-between gap-3 border-b border-line/50 py-2.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <span className="font-mono text-[12.5px] text-ink">{a.action}</span>
                      <span className="ml-2 text-[12px] text-muted">by {a.actor}</span>
                    </div>
                    <div className="shrink-0 text-right font-mono text-[11px] text-muted">
                      <div>#{a.seq} · {a.at}</div>
                      <div className="text-muted/60">{a.hash}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
