import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { cn } from "@/lib/utils";
import { fetchActiveSession } from "@/lib/data/roster";
import type { ActiveSession } from "@/lib/data/roster";
import { fetchZoneAggregates } from "@/lib/data/engagement";
import type { ZoneAggregateRow } from "@/lib/data/engagement";
import { fetchManagementSessions } from "@/lib/data/live";
import type { ManagementSessionRow } from "@/lib/data/live";
import { VneiPanel } from "@/components/charts/VneiPanel";
import { Activity, GaugeCircle, RefreshCw, WifiOff } from "lucide-react";
import { guardRoute } from "@/lib/auth-guard";

export const Route = createFileRoute("/_shell/management")({
  beforeLoad: guardRoute(["management"]),
  head: () => ({
    meta: [{ title: "Management · SensePro+" }],
  }),
  component: ManagementPage,
});

interface ManagementSnapshot {
  session: ActiveSession | null;
  rows: ZoneAggregateRow[];
  sessions: ManagementSessionRow[];
  updatedAt: Date;
}

function formatSessionLabel(session: ManagementSessionRow): string {
  const title =
    session.class_name === session.class_section
      ? session.class_section
      : `${session.class_name} · ${session.class_section}`;
  const started = new Date(session.started_at).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${title} · ${started}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function ManagementPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [snapshot, setSnapshot] = useState<ManagementSnapshot>({
    session: null,
    rows: [],
    sessions: [],
    updatedAt: new Date(0),
  });
  const [comparison, setComparison] = useState({ a: "", b: "" });
  const refreshInFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [active, mgmtSessions] = await Promise.all([
        fetchActiveSession("workshop"),
        fetchManagementSessions(8, "workshop"),
      ]);
      const aggregateRows = active ? await fetchZoneAggregates(active.id) : [];
      if (!mounted.current) return;

      setSnapshot({
        session: active,
        rows: aggregateRows,
        sessions: mgmtSessions,
        updatedAt: new Date(),
      });
      setComparison((previous) => {
        const ids = mgmtSessions.map((item) => item.id);
        const a = ids.includes(previous.a) ? previous.a : (ids[0] ?? "");
        const b =
          ids.includes(previous.b) && previous.b !== a
            ? previous.b
            : (ids.find((id) => id !== a) ?? "");
        return { a, b };
      });
      setLoad("ready");
    } catch {
      if (mounted.current) setLoad("error");
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const { session, rows, sessions, updatedAt } = snapshot;

  const trend = useMemo(
    () =>
      sessions
        .slice()
        .reverse()
        .map((item) => ({
          id: item.id,
          axisLabel: new Date(item.started_at).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          sessionLabel: formatSessionLabel(item),
          vnei: item.vnei,
        })),
    [sessions],
  );
  const hasTrendData = trend.some((item) => item.vnei !== null);
  const updatedLabel = updatedAt.getTime()
    ? updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const chooseSession = (side: "a" | "b", value: string) => {
    setComparison((previous) => {
      if (side === "a") {
        const b =
          previous.b === value
            ? (sessions.find((item) => item.id !== value)?.id ?? "")
            : previous.b;
        return { a: value, b };
      }
      const a =
        previous.a === value ? (sessions.find((item) => item.id !== value)?.id ?? "") : previous.a;
      return { a, b: value };
    });
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
            Management · workshops
          </div>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-[color:var(--ink)]">
            Engagement oversight
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[color:var(--muted)]">
            Class and zone aggregates for workshop delivery. No participant identity or individual
            engagement score is available on this view.
          </p>
        </div>
        {load === "ready" ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--muted)] transition-colors hover:border-[color:var(--primary)] hover:text-[color:var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
          >
            <RefreshCw className="h-4 w-4" /> Refreshed {updatedLabel}
          </button>
        ) : null}
      </header>

      {load === "loading" ? (
        <section className="glass-panel grid min-h-64 place-items-center p-6" aria-busy="true">
          <p className="font-mono-nums text-xs text-[color:var(--muted)]">
            Loading workshop aggregates…
          </p>
        </section>
      ) : load === "error" ? (
        <section className="glass-panel flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
          <WifiOff className="h-9 w-9 text-[color:var(--warn)]" />
          <div>
            <h2 className="font-display text-xl font-bold text-[color:var(--ink)]">
              Workshop data is unavailable
            </h2>
            <p className="mt-1 max-w-md text-sm text-[color:var(--muted)]">
              The live and historical snapshot did not refresh together, so retained values are
              hidden rather than presented under the wrong session.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoad("loading");
              void refresh();
            }}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </section>
      ) : (
        <>
          <section className="glass-panel p-5 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Live workshop evidence
                </div>
                <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                  {session ? (session.subject ?? "Active workshop") : "No active workshop"}
                </div>
                {session ? (
                  <p className="mt-1 font-mono-nums text-[11px] text-[color:var(--muted)]">
                    {session.class_section} · started {new Date(session.starts_at).toLocaleString()}
                  </p>
                ) : null}
              </div>
              {session ? (
                <span className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-3 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--accent)]">
                  <Activity className="h-4 w-4" /> aggregate stream live
                </span>
              ) : null}
            </header>

            <div className="mt-5">
              {!session ? (
                <div className="flex min-h-52 flex-col items-center justify-center text-center text-[color:var(--muted)]">
                  <GaugeCircle className="mb-3 h-8 w-8 opacity-50" />
                  <p className="font-medium text-[color:var(--ink)]">No live workshop</p>
                  <p className="mt-1 max-w-md text-sm">
                    Start a workshop from Capture to receive anonymous class and zone aggregates.
                  </p>
                </div>
              ) : rows.length === 0 ? (
                <div className="flex min-h-52 flex-col items-center justify-center text-center text-[color:var(--muted)]">
                  <GaugeCircle className="mb-3 h-8 w-8 opacity-50" />
                  <p className="font-medium text-[color:var(--ink)]">No reportable aggregate yet</p>
                  <p className="mt-1 max-w-lg text-sm">
                    A missing row can reflect privacy, pose-observability, or persistence gates. It
                    is withheld rather than estimated as zero.
                  </p>
                </div>
              ) : (
                <VneiPanel rows={rows} />
              )}
            </div>
          </section>

          <section className="glass-panel p-5 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Completed workshops · VNEI
                </div>
                <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                  Reportable trend across sessions
                </div>
              </div>
              <p className="max-w-sm font-mono-nums text-[11px] text-[color:var(--muted)]">
                Gaps mean that no aggregate was reportable; the line does not bridge them.
              </p>
            </header>

            <div className="mt-5 h-[260px]" aria-label="Workshop VNEI trend chart">
              {!hasTrendData ? (
                <div className="grid h-full place-items-center text-center text-[color:var(--muted)]">
                  <div>
                    <GaugeCircle className="mx-auto mb-3 h-8 w-8 opacity-50" />
                    <p className="text-sm">No completed workshop has reportable engagement yet.</p>
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    accessibilityLayer
                    data={trend}
                    margin={{ top: 10, right: 12, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="axisLabel"
                      tick={{ fill: "var(--muted)", fontFamily: "IBM Plex Mono", fontSize: 10 }}
                      axisLine={{ stroke: "var(--line)" }}
                      tickLine={{ stroke: "var(--line)" }}
                    />
                    <YAxis
                      domain={[0, 1]}
                      width={50}
                      tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
                      tick={{ fill: "var(--muted)", fontFamily: "IBM Plex Mono", fontSize: 10 }}
                      axisLine={{ stroke: "var(--line)" }}
                      tickLine={{ stroke: "var(--line)" }}
                    />
                    <Tooltip
                      formatter={(value) => [`${Math.round(Number(value) * 100)}%`, "VNEI"]}
                      labelFormatter={(label, payload) =>
                        payload[0]?.payload.sessionLabel ?? String(label)
                      }
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        color: "var(--ink)",
                        fontFamily: "IBM Plex Mono",
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "var(--muted)" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="vnei"
                      name="VNEI"
                      connectNulls={false}
                      stroke="var(--primary)"
                      strokeWidth={2.5}
                      dot={{ fill: "var(--primary)", stroke: "var(--surface)", r: 3 }}
                      activeDot={{ r: 5, fill: "var(--accent)" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {sessions.length > 0 ? (
              <div className="mt-4 overflow-x-auto rounded-md border border-[color:var(--line)]">
                <table className="w-full min-w-[660px] border-collapse text-left">
                  <caption className="sr-only">
                    Exact values for the completed workshop trend
                  </caption>
                  <thead className="bg-[color:var(--surface-2)]">
                    <tr className="font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                      <th className="px-3 py-2 font-medium">Workshop</th>
                      <th className="px-3 py-2 text-right font-medium">VNEI</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Coverage in reportable zones
                      </th>
                      <th className="px-3 py-2 text-right font-medium">Reportable windows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((item) => (
                      <tr
                        key={item.id}
                        className="border-t border-[color:var(--line)] text-xs text-[color:var(--ink)]"
                      >
                        <td className="px-3 py-2.5">{formatSessionLabel(item)}</td>
                        <td className="px-3 py-2.5 text-right font-mono-nums">
                          {item.vnei === null ? "Withheld" : formatPercent(item.vnei)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono-nums">
                          {formatPercent(item.coverage)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono-nums">
                          {item.reportable_windows}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <section className="glass-panel p-5 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Workshop compare
                </div>
                <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
                  Side-by-side aggregate evidence
                </div>
              </div>
              {sessions.length >= 2 ? (
                <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end lg:w-auto">
                  <SessionPick
                    id="workshop-compare-a"
                    label="Workshop A"
                    value={comparison.a}
                    excludedId={comparison.b}
                    onChange={(value) => chooseSession("a", value)}
                    sessions={sessions}
                  />
                  <span className="hidden pb-3 font-mono-nums text-xs text-[color:var(--muted)] sm:block">
                    vs
                  </span>
                  <SessionPick
                    id="workshop-compare-b"
                    label="Workshop B"
                    value={comparison.b}
                    excludedId={comparison.a}
                    onChange={(value) => chooseSession("b", value)}
                    sessions={sessions}
                  />
                </div>
              ) : null}
            </header>

            {sessions.length < 2 ? (
              <p className="mt-4 font-mono-nums text-xs text-[color:var(--muted)]">
                Need at least two completed workshops to compare.
              </p>
            ) : (
              <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
                {[comparison.a, comparison.b].map((id) => {
                  const item = sessions.find((sessionItem) => sessionItem.id === id);
                  if (!item) return null;
                  return (
                    <article
                      key={item.id}
                      className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-2)]/60 p-5"
                    >
                      <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                        {new Date(item.started_at).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </div>
                      <div className="mt-1 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                        {item.class_name}
                      </div>
                      {item.class_name !== item.class_section ? (
                        <p className="mt-1 text-sm text-[color:var(--muted)]">
                          {item.class_section}
                        </p>
                      ) : null}
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <MiniStat
                          label="Reportable-zone coverage"
                          value={formatPercent(item.coverage)}
                        />
                        <MiniStat
                          label="VNEI"
                          value={item.vnei === null ? "Withheld" : formatPercent(item.vnei)}
                          accent
                        />
                        <MiniStat
                          label="Reportable windows"
                          value={String(item.reportable_windows)}
                        />
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SessionPick({
  id,
  label,
  value,
  excludedId,
  onChange,
  sessions,
}: {
  id: string;
  label: string;
  value: string;
  excludedId: string;
  onChange: (v: string) => void;
  sessions: ManagementSessionRow[];
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="mb-1.5 block font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="sp-focus h-12 w-full min-w-0 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 font-mono-nums text-xs text-[color:var(--ink)] outline-none focus:border-[color:var(--primary)] lg:max-w-[320px]"
      >
        {sessions.map((item) => (
          <option key={item.id} value={item.id} disabled={item.id === excludedId}>
            {formatSessionLabel(item)}
          </option>
        ))}
      </select>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2">
      <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-xl font-extrabold tracking-tight",
          accent ? "text-[color:var(--accent)]" : "text-[color:var(--ink)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
