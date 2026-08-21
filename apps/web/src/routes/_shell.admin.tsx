import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Inbox,
  Link2,
  Loader2,
  Mail,
  QrCode,
  Send,
  ShieldCheck,
  UserCheck,
  UserX,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  fetchAuditLive,
  fetchConsentsLive,
  fetchDeletionRequestsLive,
  fetchDevicesLive,
} from "@/lib/data/live";
import { resolveDeletionRequest } from "@/lib/data/deletion";
import { fetchSetting, updateSetting } from "@/lib/data/settings";
import { fetchNotificationStatus, sendTestNotification } from "@/lib/data/notify";
import {
  fetchAdminRoleRequests,
  resolveAdminRoleRequest,
  sendAdminRoleDigest,
} from "@/lib/data/role-requests";
import type { NotificationStatus } from "@/lib/data/notify";
import type {
  AuditEntry,
  ConsentRecord,
  DeletionRequestRow,
  DeviceRow,
  RoleRequestRow,
} from "@/lib/data/types";
import { guardRoute } from "@/lib/auth-guard";

export const Route = createFileRoute("/_shell/admin")({
  beforeLoad: guardRoute(["admin"]),
  head: () => ({
    meta: [{ title: "Admin · SensePro+" }],
  }),
  component: AdminPage,
});

const TABS = [
  "Devices",
  "Role requests",
  "Users & roles",
  "Consent",
  "Deletion queue",
  "Audit chain",
  "Notifications",
] as const;
type Tab = (typeof TABS)[number];

type Load = "loading" | "ready" | "error";

function AdminPage() {
  const [tab, setTab] = useState<Tab>("Devices");
  const [load, setLoad] = useState<Load>("loading");
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [deletions, setDeletions] = useState<DeletionRequestRow[]>([]);
  const [roleRequests, setRoleRequests] = useState<RoleRequestRow[]>([]);
  const [pendingRoleCount, setPendingRoleCount] = useState(0);
  const [sendingDigest, setSendingDigest] = useState(false);
  const [qrEnabled, setQrEnabled] = useState<boolean | null>(null);
  const [qrToggling, setQrToggling] = useState(false);
  const [notifyStatus, setNotifyStatus] = useState<NotificationStatus | null>(null);
  const [testEmail, setTestEmail] = useState("vashishtha.vishwas@gmail.com");
  const [sendingTest, setSendingTest] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      fetchDevicesLive().catch(() => []),
      fetchConsentsLive().catch(() => []),
      fetchAuditLive().catch(() => []),
      fetchDeletionRequestsLive().catch(() => []),
      fetchSetting("qr_checkin_enabled").catch(() => true),
      fetchNotificationStatus().catch(() => null),
      fetchAdminRoleRequests().catch(() => ({ items: [], pending_count: 0 })),
    ])
      .then(([dRes, cRes, aRes, delRes, qrRes, notifRes, roleReqsRes]) => {
        if (!mounted) return;
        setDevices(dRes.status === "fulfilled" ? dRes.value : []);
        setConsents(cRes.status === "fulfilled" ? cRes.value : []);
        setAudit(aRes.status === "fulfilled" ? aRes.value : []);
        setDeletions(delRes.status === "fulfilled" ? delRes.value : []);
        setQrEnabled(qrRes.status === "fulfilled" ? qrRes.value : true);
        const roleReqs =
          roleReqsRes.status === "fulfilled"
            ? roleReqsRes.value
            : { items: [], pending_count: 0 };
        setRoleRequests(roleReqs.items || []);
        setPendingRoleCount(roleReqs.pending_count || 0);
        if (notifRes.status === "fulfilled" && notifRes.value) {
          setNotifyStatus(notifRes.value);
          if (notifRes.value.admin_notify_email) setTestEmail(notifRes.value.admin_notify_email);
        }
        setLoad("ready");
      })
      .catch(() => {
        if (mounted) setLoad("ready");
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleSendTest() {
    if (!testEmail.trim() || sendingTest) return;
    setSendingTest(true);
    try {
      await sendTestNotification(testEmail.trim());
      toast.success(`Verification email dispatched to ${testEmail.trim()} via Resend.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send test email");
    } finally {
      setSendingTest(false);
    }
  }

  async function handleQrToggle() {
    if (qrEnabled === null || qrToggling) return;
    const next = !qrEnabled;
    setQrToggling(true);
    setQrEnabled(next); // optimistic, reverted on failure
    try {
      await updateSetting("qr_checkin_enabled", next);
      toast.success(`QR check-in ${next ? "enabled" : "disabled"} campus-wide.`);
    } catch (err) {
      setQrEnabled(!next);
      toast.error(err instanceof Error ? err.message : "Toggle failed — not saved");
    } finally {
      setQrToggling(false);
    }
  }

  async function handleResolve(id: string, approve: boolean) {
    setDeletions((rows) =>
      rows.map((r) => (r.id === id ? { ...r, status: approve ? "approved" : "denied" } : r)),
    );
    try {
      await resolveDeletionRequest(id, approve);
      toast.success(approve ? "Approved — biometric template purged." : "Request denied.");
    } catch (err) {
      // Revert the optimistic update; refetch to get the true server state.
      fetchDeletionRequestsLive()
        .then(setDeletions)
        .catch(() => undefined);
      toast.error(err instanceof Error ? err.message : "Resolve failed");
    }
  }

  async function handleResolveRole(id: string, approve: boolean, assignedRole?: string) {
    setRoleRequests((rows) =>
      rows.map((r) =>
        r.id === id
          ? {
              ...r,
              status: approve ? "approved" : "rejected",
              resolved_role: assignedRole ?? r.requested_role,
            }
          : r,
      ),
    );
    setPendingRoleCount((c) => Math.max(0, c - 1));
    try {
      await resolveAdminRoleRequest(id, approve, assignedRole);
      toast.success(
        approve
          ? `Approved as ${assignedRole?.toUpperCase() ?? "ROLE"} — permissions assigned and user notified.`
          : "Role request rejected.",
      );
    } catch (err) {
      fetchAdminRoleRequests()
        .then((res) => {
          setRoleRequests(res.items);
          setPendingRoleCount(res.pending_count);
        })
        .catch(() => undefined);
      toast.error(err instanceof Error ? err.message : "Resolve failed");
    }
  }

  async function handleSendRoleDigest() {
    setSendingDigest(true);
    try {
      const res = await sendAdminRoleDigest();
      toast.success(
        `Role requests digest dispatched to admin email (${res.pending_count} pending).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send digest");
    } finally {
      setSendingDigest(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 text-[color:var(--accent)]">
            <QrCode className="h-5 w-5" />
          </div>
          <div>
            <div className="font-mono-nums text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              Global feature toggle
            </div>
            <div className="font-display text-base font-extrabold tracking-tight text-[color:var(--ink)]">
              QR check-in for unverified students
            </div>
          </div>
        </div>
        {qrEnabled === null ? (
          <Loader2 className="h-5 w-5 animate-spin text-[color:var(--muted)]" />
        ) : (
          <button
            onClick={() => void handleQrToggle()}
            disabled={qrToggling}
            role="switch"
            aria-checked={qrEnabled}
            aria-label="Toggle QR check-in for unverified students"
            className={cn(
              "sp-focus relative h-8 w-14 rounded-full transition-colors disabled:opacity-50",
              qrEnabled
                ? "bg-[color:var(--ok)]"
                : "bg-[color:var(--surface-2)] border border-[color:var(--line)]",
            )}
          >
            <span
              className={cn(
                "absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform",
                qrEnabled ? "translate-x-7" : "translate-x-1",
              )}
            />
          </button>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "sp-focus inline-flex min-h-12 items-center gap-1.5 rounded px-4 font-mono-nums text-[11px] uppercase tracking-wider transition-colors",
              tab === t
                ? "bg-[color:var(--primary)] text-white"
                : "text-[color:var(--muted)] hover:text-[color:var(--ink)]",
            )}
          >
            <span>{t}</span>
            {t === "Role requests" && pendingRoleCount > 0 && (
              <span className="rounded-full bg-[color:var(--warn)]/25 px-1.5 py-0.5 text-[10px] font-bold text-[color:var(--warn)]">
                {pendingRoleCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {load === "error" && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/40 py-12 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load admin data
          </div>
          <p className="text-sm">Check your connection and role, then refresh.</p>
        </div>
      )}

      {load !== "error" && tab === "Devices" && (
        <Panel title="Capture clients" hint="Board kiosks + lab kiosks with SensePro capture">
          {load === "loading" ? (
            <LoadingRows />
          ) : devices.length === 0 ? (
            <EmptyState text="No capture devices registered yet." />
          ) : (
            <Table
              head={["Label", "Room", "Last seen", "Status"]}
              rows={devices.map((d) => [
                d.label,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">{d.room}</span>,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {d.last_seen ? new Date(d.last_seen).toLocaleTimeString() : "never"}
                </span>,
                <StatusDot status={d.status} />,
              ])}
            />
          )}
        </Panel>
      )}

      {load !== "error" && tab === "Role requests" && (
        <Panel
          title="Role access requests"
          hint={`Assign roles to newly registered users · ${pendingRoleCount} pending review`}
        >
          <div className="border-b border-[color:var(--line)] bg-[color:var(--surface-2)]/20 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5 font-mono-nums text-xs">
                  <span className="text-[color:var(--muted)]">Pending:</span>
                  <span className="font-bold text-[color:var(--warn)]">{pendingRoleCount}</span>
                </div>
                <div className="flex items-center gap-1.5 font-mono-nums text-xs">
                  <span className="text-[color:var(--muted)]">Approved:</span>
                  <span className="font-bold text-[color:var(--ok)]">
                    {roleRequests.filter((r) => r.status === "approved").length}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 font-mono-nums text-xs">
                  <span className="text-[color:var(--muted)]">Total:</span>
                  <span className="font-bold text-[color:var(--ink)]">{roleRequests.length}</span>
                </div>
              </div>

              <button
                onClick={() => void handleSendRoleDigest()}
                disabled={sendingDigest || pendingRoleCount === 0}
                className="sp-focus inline-flex items-center justify-center gap-1.5 rounded-md border border-[color:var(--primary)]/40 bg-[color:var(--primary)]/10 px-3 py-1.5 font-mono-nums text-xs font-semibold text-[color:var(--ink)] transition-colors hover:bg-[color:var(--primary)]/20 disabled:opacity-40"
              >
                <Mail className={`h-3.5 w-3.5 ${sendingDigest ? "animate-spin" : ""}`} />
                <span>{sendingDigest ? "Sending Digest…" : "Send Email Digest"}</span>
              </button>
            </div>
          </div>

          {load === "loading" ? (
            <LoadingRows />
          ) : roleRequests.length === 0 ? (
            <EmptyState text="No role access requests found in queue." />
          ) : (
            <Table
              head={["Requester", "Requested Role", "Department / Reason", "Submitted", "Status", "Actions"]}
              rows={roleRequests.map((r) => [
                <div className="flex flex-col">
                  <span className="font-medium text-[color:var(--ink)]">{r.full_name || "User"}</span>
                  <span className="font-mono text-xs text-[color:var(--muted)]">{r.email}</span>
                </div>,
                <span className="inline-flex rounded border border-[color:var(--primary)]/30 bg-[color:var(--primary)]/10 px-2 py-0.5 font-mono-nums text-[10px] font-bold uppercase tracking-wider text-[color:var(--ink)]">
                  {r.requested_role}
                </span>,
                <span className="text-xs italic text-[color:var(--muted)]">
                  {r.reason ? `"${r.reason}"` : "—"}
                </span>,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {new Date(r.created_at).toLocaleString()}
                </span>,
                <RoleStatusPill status={r.status} resolvedRole={r.resolved_role} />,
                r.status === "pending" ? (
                  <RoleRequestActions
                    requestId={r.id}
                    requestedRole={r.requested_role}
                    onResolve={handleResolveRole}
                  />
                ) : (
                  <span className="font-mono-nums text-[10px] text-[color:var(--muted)]">
                    {r.resolved_at ? new Date(r.resolved_at).toLocaleDateString() : "resolved"}
                  </span>
                ),
              ])}
            />
          )}
        </Panel>
      )}

      {tab === "Users & roles" && (
        <Panel title="Users & roles" hint="Roles are stored in a separate table; RLS enforced">
          <div className="rounded-md border border-dashed border-[color:var(--line)] bg-[color:var(--surface-2)]/30 px-4 py-6 text-center">
            <p className="text-sm text-[color:var(--muted)]">
              Not available yet. <code className="font-mono-nums text-xs">user_roles</code> is
              deliberately locked to the auth server (migration 0003) — listing users and roles here
              needs a service-role admin endpoint, which hasn't been built.
            </p>
          </div>
        </Panel>
      )}

      {load !== "error" && tab === "Consent" && (
        <Panel title="Consent registry" hint="Version-tracked, signed on device">
          {load === "loading" ? (
            <LoadingRows />
          ) : consents.length === 0 ? (
            <EmptyState text="No consent records yet." />
          ) : (
            <Table
              head={["Reg no", "Name", "Version", "Signed", "Status"]}
              rows={consents.map((c) => [
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {c.reg_no}
                </span>,
                <span className="text-[color:var(--ink)]">{c.name}</span>,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {c.version}
                </span>,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {new Date(c.signed_at).toLocaleDateString()}
                </span>,
                <span
                  className={cn(
                    "rounded border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider",
                    c.status === "active"
                      ? "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]"
                      : "border-[color:var(--muted)]/40 bg-[color:var(--surface)] text-[color:var(--muted)]",
                  )}
                >
                  {c.status}
                </span>,
              ])}
            />
          )}
        </Panel>
      )}

      {load !== "error" && tab === "Deletion queue" && (
        <Panel
          title="Deletion requests"
          hint="Approve purges the biometric template + withdraws consent · irreversible"
        >
          {load === "loading" ? (
            <LoadingRows />
          ) : deletions.length === 0 ? (
            <EmptyState text="No deletion requests." />
          ) : (
            <Table
              head={["Reg no", "Name", "Requested", "Status", ""]}
              rows={deletions.map((d) => [
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {d.reg_no}
                </span>,
                <span className="text-[color:var(--ink)]">{d.name}</span>,
                <span className="font-mono-nums text-xs text-[color:var(--muted)]">
                  {new Date(d.requested_at).toLocaleString()}
                </span>,
                <StatusPill status={d.status} />,
                d.status === "pending" ? (
                  <DeletionActions requestId={d.id} onResolve={handleResolve} />
                ) : (
                  <span className="font-mono-nums text-[10px] text-[color:var(--muted)]">—</span>
                ),
              ])}
            />
          )}
        </Panel>
      )}

      {load !== "error" && tab === "Audit chain" && (
        <Panel
          title="Audit chain"
          hint="Append-only · each entry's prev_hash equals the previous entry's hash"
        >
          {load === "loading" ? (
            <LoadingRows />
          ) : audit.length === 0 ? (
            <EmptyState text="No audit entries yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[color:var(--line)]">
                    {["Seq", "Time", "Actor", "Action", "prev_hash", "", "hash", "Chain"].map(
                      (h, i) => (
                        <th
                          key={i}
                          className="px-3 py-2 text-left font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="font-mono-nums text-xs">
                  {audit.map((a, i) => {
                    // audit is newest-first; the entry that "produced" prev_hash is the one BELOW this row
                    const parent = audit[i + 1];
                    const ok = !parent || parent.hash === a.prev_hash;
                    return (
                      <tr
                        key={a.seq}
                        className="border-b border-[color:var(--line)]/60 hover:bg-[color:var(--surface-2)]/40"
                      >
                        <td className="px-3 py-2 text-[color:var(--muted)]">#{a.seq}</td>
                        <td className="px-3 py-2 text-[color:var(--muted)]">
                          {new Date(a.ts).toLocaleTimeString()}
                        </td>
                        <td className="px-3 py-2 text-[color:var(--ink)]">{a.actor}</td>
                        <td className="px-3 py-2 text-[color:var(--accent)]">{a.action}</td>
                        <td className="px-3 py-2">
                          <HashPrefix hash={a.prev_hash} muted />
                        </td>
                        <td className="px-1 py-2 text-center text-[color:var(--line)]">
                          <Link2 className="inline h-3.5 w-3.5" />
                        </td>
                        <td className="px-3 py-2">
                          <HashPrefix hash={a.hash} />
                        </td>
                        <td className="px-3 py-2">
                          {ok ? (
                            <span className="inline-flex items-center gap-1 rounded border border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[color:var(--ok)]">
                              <ShieldCheck className="h-3 w-3" /> linked
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded border border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[color:var(--bad)]">
                              <AlertTriangle className="h-3 w-3" /> broken
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {load !== "error" && tab === "Notifications" && (
        <Panel
          title="Notification channels & email dispatch"
          hint="Resend API integration for automated session summaries, proctor alerts, and privacy compliance"
        >
          <div className="space-y-6">
            {/* Status Card */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] p-4">
                <div className="font-mono-nums text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
                  Delivery Service
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[color:var(--ok)] animate-pulse" />
                  <span className="font-display text-lg font-bold text-[color:var(--ink)]">
                    Resend API
                  </span>
                </div>
                <div className="mt-1 font-mono-nums text-xs text-[color:var(--ok)]">
                  Connected &amp; Active
                </div>
              </div>

              <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] p-4">
                <div className="font-mono-nums text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
                  System Sender
                </div>
                <div className="mt-1 font-mono-nums text-sm font-semibold text-[color:var(--ink)]">
                  {notifyStatus?.from_email || "SensePro+ <onboarding@resend.dev>"}
                </div>
                <div className="mt-1 font-mono-nums text-xs text-[color:var(--muted)]">
                  Verified Dispatcher
                </div>
              </div>

              <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] p-4">
                <div className="font-mono-nums text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
                  Default Recipient
                </div>
                <div className="mt-1 truncate font-mono-nums text-sm font-semibold text-[color:var(--primary)]">
                  {notifyStatus?.admin_notify_email || "vashishtha.vishwas@gmail.com"}
                </div>
                <div className="mt-1 font-mono-nums text-xs text-[color:var(--muted)]">
                  Administrator Channel
                </div>
              </div>
            </div>

            {/* Configured Triggers */}
            <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] p-5">
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-[color:var(--ink)]">
                Active Event Triggers
              </h3>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded border border-[color:var(--line)]/60 bg-[color:var(--surface-2)]/50 p-3">
                  <div className="flex items-center gap-2 font-medium text-[color:var(--ink)] text-sm">
                    <CheckCircle2 className="h-4 w-4 text-[color:var(--ok)]" /> Session Summary
                  </div>
                  <p className="mt-1 text-xs text-[color:var(--muted)]">
                    Dispatched automatically when an instructor saves &amp; ends a session. Includes headcount, attended %, and VNEI score.
                  </p>
                </div>

                <div className="rounded border border-[color:var(--line)]/60 bg-[color:var(--surface-2)]/50 p-3">
                  <div className="flex items-center gap-2 font-medium text-[color:var(--ink)] text-sm">
                    <CheckCircle2 className="h-4 w-4 text-[color:var(--ok)]" /> Proctoring Alert
                  </div>
                  <p className="mt-1 text-xs text-[color:var(--muted)]">
                    Dispatched on severe cheating flags (phone detection, extra person) during active examinations.
                  </p>
                </div>

                <div className="rounded border border-[color:var(--line)]/60 bg-[color:var(--surface-2)]/50 p-3">
                  <div className="flex items-center gap-2 font-medium text-[color:var(--ink)] text-sm">
                    <CheckCircle2 className="h-4 w-4 text-[color:var(--ok)]" /> Erasure Notice
                  </div>
                  <p className="mt-1 text-xs text-[color:var(--muted)]">
                    Dispatched to data protection officers when a student files a facial template deletion request.
                  </p>
                </div>
              </div>
            </div>

            {/* Test Email Form */}
            <div className="rounded-lg border border-[color:var(--primary)]/30 bg-[color:var(--surface)] p-5">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-[color:var(--primary)]" />
                <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-[color:var(--ink)]">
                  Verify Email Channel Delivery
                </h3>
              </div>
              <p className="mt-1 text-xs text-[color:var(--muted)]">
                Send a real-time test verification email via Resend to verify deliverability and inbox placement.
              </p>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="recipient@example.com"
                  className="sp-focus min-w-[280px] flex-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 py-2 text-sm text-[color:var(--ink)]"
                />
                <button
                  onClick={() => void handleSendTest()}
                  disabled={sendingTest || !testEmail.trim()}
                  className="sp-focus inline-flex items-center justify-center gap-2 rounded-md bg-[color:var(--primary)] px-4 py-2 font-mono-nums text-xs font-semibold uppercase tracking-wider text-[#07070A] transition-colors hover:bg-[color:var(--primary-deep)] disabled:opacity-50"
                >
                  {sendingTest ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      Send Test Email
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-panel overflow-hidden">
      <header className="flex items-center justify-between border-b border-[color:var(--line)] px-5 py-4">
        <div className="font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
          {title}
        </div>
        {hint && <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">{hint}</div>}
      </header>
      {children}
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
      loading…
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">{text}</div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[color:var(--line)]">
            {head.map((h) => (
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
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-[color:var(--line)]/60 hover:bg-[color:var(--surface-2)]/40"
            >
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-sm">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusDot({ status }: { status: "online" | "idle" | "offline" }) {
  const color =
    status === "online" ? "var(--ok)" : status === "idle" ? "var(--warn)" : "var(--muted)";
  return (
    <span
      className="inline-flex items-center gap-2 font-mono-nums text-[11px] uppercase tracking-wider"
      style={{ color }}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {status}
    </span>
  );
}

function StatusPill({ status }: { status: DeletionRequestRow["status"] }) {
  const styles =
    status === "approved"
      ? "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]"
      : status === "denied"
        ? "border-[color:var(--muted)]/40 bg-[color:var(--surface)] text-[color:var(--muted)]"
        : "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]";
  return (
    <span
      className={cn(
        "rounded border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider",
        styles,
      )}
    >
      {status}
    </span>
  );
}

/** Approve is gated behind an inline two-step confirm — it's an irreversible
 * biometric purge (backend/app/admin_api.py), matching the same
 * confirm-before-destructive-action pattern _shell.me.tsx uses to submit it. */
function DeletionActions({
  requestId,
  onResolve,
}: {
  requestId: string;
  onResolve: (id: string, approve: boolean) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(approve: boolean) {
    setBusy(true);
    try {
      await onResolve(requestId, approve);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono-nums text-[10px] text-[color:var(--bad)]">Purge for real?</span>
        <button
          onClick={() => void run(true)}
          disabled={busy}
          className="sp-focus rounded border border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10 px-2 py-1 font-mono-nums text-[10px] uppercase text-[color:var(--bad)] transition-colors hover:bg-[color:var(--bad)]/20 disabled:opacity-50"
        >
          {busy ? "…" : "Confirm"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="sp-focus rounded border border-[color:var(--line)] px-2 py-1 font-mono-nums text-[10px] uppercase text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setConfirming(true)}
        className="sp-focus rounded border border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10 px-2 py-1 font-mono-nums text-[10px] uppercase text-[color:var(--bad)] transition-colors hover:bg-[color:var(--bad)]/20"
      >
        Approve &amp; purge
      </button>
      <button
        onClick={() => void run(false)}
        className="sp-focus rounded border border-[color:var(--line)] px-2 py-1 font-mono-nums text-[10px] uppercase text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]"
      >
        Deny
      </button>
    </div>
  );
}

function HashPrefix({ hash, muted }: { hash: string; muted?: boolean }) {
  return (
    <span
      title={hash}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px]",
        muted
          ? "border-[color:var(--line)] bg-[color:var(--surface)] text-[color:var(--muted)]"
          : "border-[color:var(--primary)]/40 bg-[color:var(--primary)]/10 text-[color:var(--ink)]",
      )}
    >
      <span className="opacity-50">0x</span>
      {hash.slice(0, 8)}
      <span className="opacity-40">…</span>
    </span>
  );
}

function RoleStatusPill({
  status,
  resolvedRole,
}: {
  status: RoleRequestRow["status"];
  resolvedRole?: string | null;
}) {
  const styles =
    status === "approved"
      ? "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]"
      : status === "rejected"
        ? "border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 text-[color:var(--bad)]"
        : "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]";
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          "rounded border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider",
          styles,
        )}
      >
        {status}
      </span>
      {resolvedRole && status === "approved" && (
        <span className="font-mono-nums text-[10px] text-[color:var(--muted)]">
          ({resolvedRole})
        </span>
      )}
    </div>
  );
}

function RoleRequestActions({
  requestId,
  requestedRole,
  onResolve,
}: {
  requestId: string;
  requestedRole: string;
  onResolve: (id: string, approve: boolean, role?: string) => void | Promise<void>;
}) {
  const [selectedRole, setSelectedRole] = useState(requestedRole);
  const [busy, setBusy] = useState(false);

  async function handleApprove() {
    setBusy(true);
    try {
      await onResolve(requestId, true, selectedRole);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    setBusy(true);
    try {
      await onResolve(requestId, false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={selectedRole}
        onChange={(e) => setSelectedRole(e.target.value)}
        disabled={busy}
        aria-label="Select role to assign"
        className="sp-focus rounded border border-[color:var(--line)] bg-[color:var(--surface-2)] px-2 py-1 font-mono-nums text-[11px] text-[color:var(--ink)]"
      >
        <option value="teacher">Teacher</option>
        <option value="management">Management</option>
        <option value="student">Student</option>
        <option value="admin">Admin</option>
      </select>

      <button
        onClick={() => void handleApprove()}
        disabled={busy}
        className="sp-focus inline-flex items-center gap-1 rounded border border-[color:var(--ok)]/50 bg-[color:var(--ok)]/10 px-2.5 py-1 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--ok)] transition-colors hover:bg-[color:var(--ok)]/20 disabled:opacity-50"
      >
        <UserCheck className="h-3 w-3" />
        <span>{busy ? "…" : "Approve"}</span>
      </button>

      <button
        onClick={() => void handleReject()}
        disabled={busy}
        className="sp-focus inline-flex items-center gap-1 rounded border border-[color:var(--line)] px-2 py-1 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--muted)] transition-colors hover:border-[color:var(--bad)]/40 hover:text-[color:var(--bad)] disabled:opacity-50"
      >
        <UserX className="h-3 w-3" />
        <span>Reject</span>
      </button>
    </div>
  );
}
