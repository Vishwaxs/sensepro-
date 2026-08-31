import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Activity, Download, ShieldAlert, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { guardRoute } from "@/lib/auth-guard";
import { fetchSessionsLive } from "@/lib/data/live";
import type { SessionHistoryRow } from "@/lib/data/live";
import { deriveRoster, fetchIntervals, fetchStudents } from "@/lib/data/roster";
import { exportSessionPdf } from "@/lib/data/report";

export const Route = createFileRoute("/_shell/sessions")({
  beforeLoad: guardRoute(["teacher"]),
  head: () => ({
    meta: [{ title: "Sessions · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: SessionsPage,
});

const MODE_LABEL: Record<SessionHistoryRow["mode"], string> = {
  lecture: "attendance",
  exam: "exam",
  workshop: "workshop",
};

const TABS = ["All", "Attendance", "Exam proctoring", "Workshop"] as const;
type Tab = (typeof TABS)[number];
const TAB_MODE: Record<Tab, SessionHistoryRow["mode"] | null> = {
  All: null,
  Attendance: "lecture",
  "Exam proctoring": "exam",
  Workshop: "workshop",
};

function SessionsPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [rows, setRows] = useState<SessionHistoryRow[]>([]);
  const [exporting, setExporting] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("All");

  useEffect(() => {
    let mounted = true;
    fetchSessionsLive()
      .then((r) => {
        if (mounted) {
          setRows(r);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (mounted) setLoad("error");
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleExport(row: SessionHistoryRow) {
    setExporting(row.id);
    try {
      const students = await fetchStudents(row.class_section);
      const intervals = await fetchIntervals(row.id);
      const roster = deriveRoster(students, intervals);
      await exportSessionPdf({ section: row.class_section, subject: row.subject, roster });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
    }
  }

  const filteredRows = useMemo(() => {
    const mode = TAB_MODE[tab];
    return mode === null ? rows : rows.filter((r) => r.mode === mode);
  }, [rows, tab]);

  const tabCount = (t: Tab) => {
    const mode = TAB_MODE[t];
    return mode === null ? rows.length : rows.filter((r) => r.mode === mode).length;
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
          § sessions
        </div>
        <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
          Session history
        </h2>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          Attendance, examination review, and workshop analytics keep their own outcomes.
        </p>
      </header>

      {load === "ready" && rows.length > 0 && (
        <div className="flex items-center gap-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] p-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={cn(
                "sp-focus min-h-12 rounded px-4 font-mono-nums text-[11px] uppercase tracking-wider transition-colors",
                tab === t
                  ? "bg-[color:var(--primary)] text-white"
                  : "text-[color:var(--muted)] hover:text-[color:var(--ink)]",
              )}
            >
              {t} <span className="ml-1 opacity-70">{tabCount(t)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="glass-panel overflow-x-auto">
        {load === "loading" ? (
          <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
            loading…
          </div>
        ) : load === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
            <WifiOff className="h-8 w-8 opacity-50" />
            <div className="font-display text-lg font-medium text-[color:var(--ink)]">
              Could not load sessions
            </div>
            <p className="text-sm">Check your connection and role, then refresh.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
            No sessions recorded yet.
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-10 text-center font-mono-nums text-xs text-[color:var(--muted)]">
            No {tab.toLowerCase()} sessions yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--line)]/60 text-left font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                <th className="px-4 py-3 font-normal">When</th>
                <th className="px-4 py-3 font-normal">Session</th>
                <th className="px-4 py-3 font-normal">Cohort</th>
                <th className="px-4 py-3 font-normal">Mode</th>
                <th className="px-4 py-3 font-normal">Outcome</th>
                <th className="px-4 py-3 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-[color:var(--line)]/50 transition-colors hover:bg-[color:var(--surface-2)]/60"
                >
                  <td className="px-4 py-3 font-mono-nums text-xs text-[color:var(--muted)]">
                    {new Date(r.starts_at).toLocaleString(undefined, {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {!r.ends_at && <span className="ml-2 text-[color:var(--ok)]">· live</span>}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--ink)]">
                    {r.subject ?? r.class_section}
                  </td>
                  <td className="px-4 py-3 font-mono-nums text-xs">{r.class_section}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-[0.16em] ${
                        r.mode === "exam"
                          ? "border-[color:var(--warn)]/30 bg-[color:var(--warn)]/10 text-[color:var(--warn)]"
                          : r.mode === "workshop"
                            ? "border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 text-[color:var(--accent)]"
                            : "border-[color:var(--primary)]/30 bg-[color:var(--primary)]/10 text-[color:var(--primary)]"
                      }`}
                    >
                      {MODE_LABEL[r.mode]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <SessionOutcome row={r} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.mode === "lecture" ? (
                      <button
                        className="sp-btn sp-btn-ghost h-11 text-xs disabled:opacity-50"
                        disabled={exporting === r.id}
                        onClick={() => void handleExport(r)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {exporting === r.id ? "Exporting…" : "Attendance PDF"}
                      </button>
                    ) : r.mode === "exam" ? (
                      <Link
                        to="/proctor"
                        search={{ session_id: r.id }}
                        className="sp-btn sp-btn-ghost h-11 text-xs"
                      >
                        <ShieldAlert className="h-3.5 w-3.5" /> Review
                      </Link>
                    ) : (
                      <span className="inline-flex h-11 items-center gap-2 px-2 font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                        <Activity className="h-3.5 w-3.5" /> Aggregate only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SessionOutcome({ row }: { row: SessionHistoryRow }) {
  if (row.mode === "lecture") {
    return (
      <span className="font-mono-nums tabular-nums text-[color:var(--ink)]">
        {row.present_count}/{row.total_count} present
      </span>
    );
  }
  if (row.mode === "exam") {
    return (
      <span className="font-mono-nums text-xs text-[color:var(--ink)]">
        {row.flag_count} review event{row.flag_count === 1 ? "" : "s"}
        {row.pending_flag_count > 0 && (
          <span className="ml-2 text-[color:var(--warn)]">{row.pending_flag_count} pending</span>
        )}
      </span>
    );
  }
  if (row.vnei === null || row.reportable_windows === 0) {
    return (
      <span className="font-mono-nums text-xs text-[color:var(--muted)]">
        No reportable aggregate
      </span>
    );
  }
  return (
    <span className="font-mono-nums text-xs text-[color:var(--ink)]">
      {Math.round(row.vnei * 100)}% weighted zone signal
      <span className="ml-2 text-[color:var(--muted)]">
        {row.reportable_windows} window{row.reportable_windows === 1 ? "" : "s"}
      </span>
    </span>
  );
}
