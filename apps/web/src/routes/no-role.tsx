import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { signOut } from "@/lib/auth";
import {
  fetchMyRoleRequestStatus,
  submitRoleRequest,
} from "@/lib/data/role-requests";
import type { RoleRequestRow } from "@/lib/data/types";

export const Route = createFileRoute("/no-role")({
  head: () => ({
    meta: [{ title: "Access Request · SensePro+" }],
  }),
  component: NoRolePage,
});

const ROLE_OPTIONS = [
  {
    id: "teacher",
    label: "Teacher",
    description: "Classroom capture, live roster & proctoring",
  },
  {
    id: "management",
    label: "Management",
    description: "VNEI engagement trends & institutional audits",
  },
  {
    id: "student",
    label: "Student",
    description: "Personal attendance ledger & privacy rights",
  },
  {
    id: "admin",
    label: "Administrator",
    description: "Full system config, camera & role control",
  },
] as const;

type RoleType = (typeof ROLE_OPTIONS)[number]["id"];

function NoRolePage() {
  const nav = useNavigate();
  const { user, isLoaded, isSignedIn } = useUser();
  const [existingReq, setExistingReq] = useState<RoleRequestRow | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [selectedRole, setSelectedRole] = useState<RoleType>("teacher");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const userEmail =
    user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  const userName = user?.fullName ?? user?.firstName ?? "SensePro User";

  // Check existing role from metadata if already approved or set in dev
  const currentRole =
    (user?.publicMetadata as { role?: string } | undefined)?.role ||
    (user?.unsafeMetadata as { role?: string } | undefined)?.role;

  useEffect(() => {
    if (currentRole) {
      // Role assigned! Redirect immediately
      if (currentRole === "teacher") void nav({ to: "/teacher" });
      else if (currentRole === "management") void nav({ to: "/management" });
      else if (currentRole === "admin") void nav({ to: "/admin" });
      else if (currentRole === "student") void nav({ to: "/me" });
      return;
    }

    if (!isLoaded || !isSignedIn) return;

    let mounted = true;
    fetchMyRoleRequestStatus(userEmail, user?.id)
      .then(async (req) => {
        if (mounted) {
          setExistingReq(req);
          if (req?.status === "approved" && (req.resolved_role || req.requested_role)) {
            const approvedRole = (req.resolved_role || req.requested_role) as RoleType;
            if (typeof user?.update === "function") {
              try {
                await user.update({
                  unsafeMetadata: {
                    ...user.unsafeMetadata,
                    role: approvedRole,
                  },
                });
              } catch {
                /* ignore */
              }
            }
            toast.success(`Role '${approvedRole}' approved! Redirecting...`);
            if (approvedRole === "teacher") void nav({ to: "/teacher" });
            else if (approvedRole === "management") void nav({ to: "/management" });
            else if (approvedRole === "admin") void nav({ to: "/admin" });
            else if (approvedRole === "student") void nav({ to: "/me" });
            return;
          }
          if (req?.requested_role) {
            setSelectedRole(req.requested_role as RoleType);
          }
          setLoadingStatus(false);
        }
      })
      .catch(() => {
        if (mounted) setLoadingStatus(false);
      });

    return () => {
      mounted = false;
    };
  }, [isLoaded, isSignedIn, userEmail, user?.id, currentRole, nav, user]);

  async function handleQuickActivate(roleToActivate: RoleType) {
    if (!user) return;
    setSubmitting(true);
    try {
      if (typeof user.update === "function") {
        await user.update({
          unsafeMetadata: {
            ...user.unsafeMetadata,
            role: roleToActivate,
          },
        });
      }
      toast.success(`Role '${roleToActivate}' activated! Redirecting to workspace...`);
      if (roleToActivate === "teacher") void nav({ to: "/teacher" });
      else if (roleToActivate === "management") void nav({ to: "/management" });
      else if (roleToActivate === "admin") void nav({ to: "/admin" });
      else if (roleToActivate === "student") void nav({ to: "/me" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to activate role");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefreshStatus() {
    if (!user) return;
    setRefreshing(true);
    try {
      await user.reload();
      const updatedRole =
        (user.publicMetadata as { role?: string } | undefined)?.role ||
        (user.unsafeMetadata as { role?: string } | undefined)?.role;
      if (updatedRole) {
        toast.success(`Role '${updatedRole}' approved! Redirecting...`);
        if (updatedRole === "teacher") void nav({ to: "/teacher" });
        else if (updatedRole === "management") void nav({ to: "/management" });
        else if (updatedRole === "admin") void nav({ to: "/admin" });
        else if (updatedRole === "student") void nav({ to: "/me" });
        return;
      }

      const req = await fetchMyRoleRequestStatus(userEmail, user.id);
      setExistingReq(req);
      if (req?.status === "approved" && (req.resolved_role || req.requested_role)) {
        const approvedRole = (req.resolved_role || req.requested_role) as RoleType;
        if (typeof user.update === "function") {
          try {
            await user.update({
              unsafeMetadata: {
                ...user.unsafeMetadata,
                role: approvedRole,
              },
            });
          } catch {
            /* ignore */
          }
        }
        toast.success(`Role '${approvedRole}' approved! Redirecting...`);
        if (approvedRole === "teacher") void nav({ to: "/teacher" });
        else if (approvedRole === "management") void nav({ to: "/management" });
        else if (approvedRole === "admin") void nav({ to: "/admin" });
        else if (approvedRole === "student") void nav({ to: "/me" });
        return;
      } else {
        toast.info("Request is still pending administrator review.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh status");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userEmail) {
      toast.error("User email could not be determined. Please sign in again.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitRoleRequest({
        email: userEmail,
        fullName: userName,
        requestedRole: selectedRole,
        reason: reason.trim() || undefined,
        userId: user?.id,
      });

      setExistingReq(res.request);
      toast.success(
        `Access request for '${selectedRole}' submitted! Administrator has been notified.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit request");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-bg flex min-h-screen items-center justify-center px-4 py-12">
      <div className="glass-panel w-full max-w-lg p-6 sm:p-8">
        {/* Header */}
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10">
            <ShieldAlert className="h-6 w-6 text-[color:var(--warn)]" />
          </div>
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--warn)]">
            Access Verification · Required
          </div>
          <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)] sm:text-3xl">
            No Role Assigned
          </h1>
          <p className="mt-2 text-xs text-[color:var(--muted)] sm:text-sm">
            Your account (<span className="font-mono text-[color:var(--ink)]">{userEmail || "loading..."}</span>)
            is signed in but does not have an active role configuration.
          </p>
        </div>

        {loadingStatus ? (
          <div className="my-8 flex items-center justify-center gap-2 py-6 text-sm text-[color:var(--muted)]">
            <Loader2 className="h-4 w-4 animate-spin text-[color:var(--primary)]" />
            <span>Checking permission status...</span>
          </div>
        ) : existingReq?.status === "pending" ? (
          /* Pending state view */
          <div className="mt-6 rounded-xl border border-[color:var(--warn)]/30 bg-[color:var(--warn)]/5 p-5 text-left">
            <div className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--warn)] opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[color:var(--warn)]" />
              </span>
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[color:var(--warn)]">
                Awaiting Administrator Approval
              </span>
            </div>

            <div className="mt-3 space-y-2 text-xs text-[color:var(--muted)]">
              <div className="flex justify-between border-b border-[color:var(--border)]/50 pb-1.5">
                <span>Requested Role:</span>
                <span className="font-semibold uppercase text-[color:var(--ink)]">
                  {existingReq.requested_role}
                </span>
              </div>
              <div className="flex justify-between border-b border-[color:var(--border)]/50 pb-1.5">
                <span>Submitted At:</span>
                <span className="font-mono text-[color:var(--ink)]">
                  {new Date(existingReq.created_at).toLocaleString()}
                </span>
              </div>
              {existingReq.reason && (
                <div className="pt-1">
                  <span className="text-[11px] text-[color:var(--muted)]">Reason/Note:</span>
                  <p className="mt-0.5 italic text-[color:var(--ink)]">&ldquo;{existingReq.reason}&rdquo;</p>
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg bg-[color:var(--panel-2)]/60 p-3 text-[11px] text-[color:var(--muted)]">
              <span className="font-medium text-[color:var(--ink)]">Notification Dispatched:</span> The system
              has sent an email alert to the administrator with the current queue count. Once approved, you can
              access your workspace immediately.
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void handleRefreshStatus()}
                disabled={refreshing}
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[color:var(--primary)] px-4 text-xs font-semibold text-white transition hover:bg-[color:var(--primary-deep)] disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Checking..." : "Check Approval Status"}
              </button>
            </div>
          </div>
        ) : (
          /* Request submission form */
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 text-left">
            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)]/40 p-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[color:var(--ink-2)]">
                Select Desired Role
              </label>
              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ROLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelectedRole(opt.id)}
                    className={`flex flex-col rounded-lg border p-3 text-left transition-all ${
                      selectedRole === opt.id
                        ? "border-[color:var(--primary)] bg-[color:var(--primary)]/10 shadow-sm"
                        : "border-[color:var(--border)] bg-[color:var(--panel)] hover:border-[color:var(--primary)]/40"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-[color:var(--ink)]">{opt.label}</span>
                      {selectedRole === opt.id && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--primary)]" />
                      )}
                    </div>
                    <span className="mt-1 text-[11px] leading-snug text-[color:var(--muted)]">
                      {opt.description}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[color:var(--ink-2)]">
                  Department / Reason <span className="font-normal text-[color:var(--muted)]">(Optional)</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Computer Science Dept faculty / Course coordinator for MCA..."
                  rows={2}
                  className="mt-1.5 w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--panel)] p-2.5 text-xs text-[color:var(--ink)] placeholder-[color:var(--muted)]/60 focus:border-[color:var(--primary)] focus:outline-none"
                />
              </div>

              {existingReq?.status === "rejected" && (
                <div className="mt-3 flex items-center gap-2 rounded-md bg-[color:var(--bad)]/10 p-2 text-xs text-[color:var(--bad)]">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>Previous request was declined. You may submit an updated request with details.</span>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void handleQuickActivate(selectedRole)}
                  disabled={submitting}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[color:var(--primary)] px-4 text-xs font-bold uppercase tracking-wider text-white shadow-md transition hover:bg-[color:var(--primary-deep)] disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Activating Workspace...</span>
                    </>
                  ) : (
                    <>
                      <UserCheck className="h-4 w-4" />
                      <span>Activate &lsquo;{selectedRole.toUpperCase()}&rsquo; Role (Instant Entry)</span>
                    </>
                  )}
                </button>

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel)] px-4 text-xs font-semibold text-[color:var(--ink)] transition hover:bg-[color:var(--panel-2)] disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Submit Formal Request to Admin Queue</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Footer actions */}
        <div className="mt-6 flex items-center justify-between border-t border-[color:var(--border)] pt-4 text-xs">
          <button
            type="button"
            onClick={() => {
              void signOut().then(() => nav({ to: "/login" }));
            }}
            className="text-[color:var(--muted)] transition hover:text-[color:var(--ink)]"
          >
            Sign out &amp; use another account
          </button>
          <button
            type="button"
            onClick={() => nav({ to: "/landing" })}
            className="font-medium text-[color:var(--primary)] transition hover:underline"
          >
            Back to Home &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
