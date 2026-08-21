import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ZoneStrip } from "@/components/charts/ZoneStrip";
import { cn } from "@/lib/utils";
import type { ZoneAggregate, Zone } from "@/lib/data/types";
import { fetchActiveSession } from "@/lib/data/roster";
import type { ActiveSession } from "@/lib/data/roster";
import { fetchZoneAggregates, latestWindow } from "@/lib/data/engagement";
import type { ZoneAggregateRow } from "@/lib/data/engagement";
import { fetchManagementSessions } from "@/lib/data/live";
import type { ManagementSessionRow } from "@/lib/data/live";
import { VneiPanel } from "@/components/charts/VneiPanel";
import { WifiOff, GaugeCircle } from "lucide-react";
import { guardRoute } from "@/lib/auth-guard";

export const Route = createFileRoute("/_shell/management")({
  beforeLoad: guardRoute(["management"]),
  head: () => ({
    meta: [{ title: "Management · SensePro+" }],
  }),
  component: ManagementPage,
});

const ZONES: Zone[] = ["front", "mid", "back"];

function ManagementPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [rows, setRows] = useState<ZoneAggregateRow[]>([]);
  const [sessions, setSessions] = useState<ManagementSessionRow[]>([]);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [active, mgmtSessions] = await Promise.all([
        fetchActiveSession("workshop"),
        fetchManagementSessions(8, "workshop"),
      ]);
      setSession(active);
      setRows(active ? await fetchZoneAggregates(active.id) : []);
      setSessions(mgmtSessions);
      setCompareA((prev) => prev || (mgmtSessions[0]?.id ?? ""));
      setCompareB((prev) => prev || (mgmtSessions[1]?.id ?? ""));
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const { byZone } = useMemo(() => latestWindow(rows), [rows]);
  const coverageZones: ZoneAggregate[] = useMemo(
    () =>
      ZONES.map((zone) => {
        const row = byZone.get(zone);
        return row
          ? {
              zone,
              vnei: row.vnei,
              naive_mean: row.vnei, // unused by ZoneStrip's rendering; no naive-vs-fair baseline is computed here
              coverage: row.coverage,
              n_tracked: row.n_tracked,
              n_visible: row.n_tracked,
              suppressed: false,
            }
          : {
              zone,
              vnei: 0,
              naive_mean: 0,
              coverage: 0,
              n_tracked: 0,
              n_visible: 0,
              suppressed: true,
            };
      }),
    [byZone],
  );

  const trend = useMemo(
    () =>
      sessions
        .filter((s) => s.vnei !== null)
        .slice()
        .reverse()
        .map((s) => ({ session: s.id.slice(0, 8), vnei: s.vnei as number })),
    [sessions],
  );

  return (
    <div className="space-y-8">
      {/* VNEI trend across recent sessions */}
      <section className="glass-panel p-6">
        <header className="flex items-center justify-between">
          <div>
            <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Workshop engagement · VNEI
            </div>
            <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              Workshop trend across sessions
            </div>
          </div>
          <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
            Aggregate only · no per-student scoring
          </div>
        </header>
        <div className="mt-4 h-[260px]">
          {load === "loading" ? (
            <div className="grid h-full place-items-center font-mono text-[12.5px] text-[color:var(--muted)]">
              loading…
            </div>
          ) : trend.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-[color:var(--muted)]">
              <div>
                <GaugeCircle className="mx-auto mb-3 h-8 w-8 opacity-50" />
                <p className="text-sm">No completed workshops with reportable engagement yet.</p>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="vneiG" x1="0" x2="1">
                    <stop offset="0%" stopColor="#F59E0B" />
                    <stop offset="100%" stopColor="#10B981" />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="2 4" />
                <XAxis
                  dataKey="session"
                  stroke="#6B6B78"
                  tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                />
                <YAxis
                  domain={[0, 1]}
                  stroke="#6B6B78"
                  tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#151519",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 8,
                    fontFamily: "IBM Plex Mono",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#6B6B78" }}
                />
                <Line
                  type="monotone"
                  dataKey="vnei"
                  stroke="url(#vneiG)"
                  strokeWidth={2.5}
                  dot={{ fill: "#F59E0B", r: 3 }}
                  activeDot={{ r: 5, fill: "#10B981" }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Live VNEI by zone */}
      <section className="glass-panel p-6">
        <header>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Engagement fairness · Live data
          </div>
          <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
            VNEI by zone
          </div>
          <div className="mt-1 font-mono-nums text-[11px] text-[color:var(--muted)]">
            Live from engagement_zone_aggregates. Every number declares its coverage; missing
            evidence is withheld.
          </div>
        </header>
        <div className="mt-4">
          {load === "loading" ? (
            <p className="py-8 text-center font-mono text-[12.5px] text-[color:var(--muted)]">
              loading aggregates…
            </p>
          ) : load === "error" ? (
            <div className="flex flex-col items-center justify-center py-12 text-[color:var(--muted)]">
              <WifiOff className="mb-4 h-8 w-8 opacity-50" />
              <div className="font-display text-lg font-medium text-[color:var(--ink)]">
                Could not load engagement data
              </div>
              <p className="mt-1 text-sm">Check your connection and role, then refresh.</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-[color:var(--muted)]">
              <GaugeCircle className="mb-4 h-8 w-8 opacity-50" />
              <div className="font-display text-lg font-medium text-[color:var(--ink)]">
                {session ? "No windows recorded yet" : "No live workshop"}
              </div>
              <p className="mt-1 text-sm">
                Zone aggregates appear once a session runs with at least 5 tracked faces in a zone.
              </p>
            </div>
          ) : (
            <VneiPanel rows={rows} />
          )}
        </div>
      </section>

      {/* Camera coverage — same live zone window as the panel above */}
      <section className="glass-panel p-6">
        <header>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Camera coverage
          </div>
          <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
            Visible participants by zone
          </div>
        </header>
        <div className="mt-4">
          {rows.length === 0 ? (
            <p className="py-4 font-mono-nums text-xs text-[color:var(--muted)]">
              No live session data yet.
            </p>
          ) : (
            <ZoneStrip zones={coverageZones} />
          )}
        </div>
      </section>

      {/* Zones — same live zone window as the panel above, larger card layout */}
      <section className="glass-panel p-6">
        <header className="flex items-center justify-between">
          <div>
            <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Room zones
            </div>
            <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              Zone engagement + coverage
            </div>
          </div>
          <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
            Aggregate per zone · no student identifiers on this view
          </div>
        </header>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/40 px-4 py-2.5">
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Coverage legend
          </div>
          <LegendSwatch tone="ok" label="≥ 70% · reportable" />
          <LegendSwatch tone="warn" label="50–69% · caution" />
          <LegendSwatch tone="lowconf" label="< 50% · low-confidence (hatched)" />
          <LegendSwatch tone="suppressed" label="No reportable row · withheld" />
          <div className="ml-auto font-mono-nums text-[10px] text-[color:var(--muted)]">
            coverage = tracked ÷ enrolled in zone
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {coverageZones.map((z) => {
            const lowConf = !z.suppressed && z.coverage < 0.5;
            const pct = Math.round(z.vnei * 100);
            return (
              <div
                key={z.zone}
                aria-label={
                  z.suppressed
                    ? `Zone ${z.zone} withheld, no reportable aggregate`
                    : lowConf
                      ? `Zone ${z.zone} low confidence, coverage ${Math.round(z.coverage * 100)} percent`
                      : `Zone ${z.zone} VNEI ${pct} of 100`
                }
                className={cn(
                  "relative overflow-hidden rounded-lg border p-5",
                  z.suppressed
                    ? "border-dashed border-[color:var(--muted)]/50 bg-[color:var(--surface-2)]/30"
                    : lowConf
                      ? "border-[color:var(--warn)]/50 bg-[color:var(--surface-2)]/40"
                      : "border-[color:var(--line)] bg-[color:var(--surface-2)]/60",
                )}
                style={
                  lowConf
                    ? {
                        backgroundImage:
                          "repeating-linear-gradient(45deg, transparent 0 8px, color-mix(in oklab, var(--warn) 22%, transparent) 8px 10px)",
                      }
                    : undefined
                }
              >
                <div className="flex items-center justify-between">
                  <div className="font-mono-nums text-[11px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                    Zone · {z.zone}
                  </div>
                  {!z.suppressed && (
                    <span
                      className={cn(
                        "rounded-md border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider",
                        z.coverage >= 0.7
                          ? "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]"
                          : z.coverage >= 0.5
                            ? "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]"
                            : "border-[color:var(--warn)]/50 bg-[color:var(--warn)]/15 text-[color:var(--warn)]",
                      )}
                    >
                      coverage {Math.round(z.coverage * 100)}%
                    </span>
                  )}
                </div>

                {z.suppressed ? (
                  <div className="mt-4 flex h-[112px] flex-col items-center justify-center rounded-md border border-dashed border-[color:var(--muted)]/50 bg-[color:var(--surface)]/40 text-center">
                    <div className="font-mono-nums text-[10px] uppercase tracking-[0.24em] text-[color:var(--muted)]">
                      withheld
                    </div>
                    <div className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--muted)]">
                      no value
                    </div>
                    <div className="mt-1 font-mono-nums text-[10px] text-[color:var(--muted)]">
                      privacy, observability, or persistence gate
                    </div>
                  </div>
                ) : lowConf ? (
                  <div className="mt-4">
                    <div className="inline-flex items-center gap-2 rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--warn)]">
                      low-confidence
                    </div>
                    <div className="mt-2 font-display text-3xl font-extrabold tracking-tight text-[color:var(--muted)]">
                      —
                    </div>
                    <div className="mt-1 font-mono-nums text-[11px] text-[color:var(--muted)]">
                      coverage {Math.round(z.coverage * 100)}% · number withheld until ≥ 50%
                    </div>
                  </div>
                ) : (
                  <div className="mt-4">
                    <div className="font-display text-5xl font-extrabold tracking-tight text-[color:var(--ink)]">
                      {pct}
                      <span className="ml-1 font-mono-nums text-lg text-[color:var(--muted)]">
                        /100
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--surface)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: "linear-gradient(90deg, var(--primary), var(--accent))",
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-3 font-mono-nums text-[11px] text-[color:var(--muted)]">
                  tracked · {z.n_tracked}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Session compare */}
      <section className="glass-panel p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Workshop compare
            </div>
            <div className="mt-0.5 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              Side-by-side engagement aggregates
            </div>
          </div>
          {sessions.length >= 2 && (
            <div className="flex items-center gap-2">
              <SessionPick value={compareA} onChange={setCompareA} sessions={sessions} />
              <span className="font-mono-nums text-xs text-[color:var(--muted)]">vs</span>
              <SessionPick value={compareB} onChange={setCompareB} sessions={sessions} />
            </div>
          )}
        </header>
        {sessions.length < 2 ? (
          <p className="mt-4 font-mono-nums text-xs text-[color:var(--muted)]">
            Need at least two completed workshops to compare.
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            {[compareA, compareB].map((id, i) => {
              const s = sessions.find((x) => x.id === id);
              if (!s) return null;
              return (
                <div
                  key={i}
                  className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-2)]/60 p-5"
                >
                  <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                    {s.id.slice(0, 8)}
                  </div>
                  <div className="mt-1 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                    {s.class_name}
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    <MiniStat
                      label="Coverage"
                      value={s.coverage !== null ? `${Math.round(s.coverage * 100)}%` : "—"}
                    />
                    <MiniStat
                      label="VNEI"
                      value={s.vnei !== null ? s.vnei.toFixed(2) : "—"}
                      accent
                    />
                    <MiniStat label="Windows" value={String(s.reportable_windows)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SessionPick({
  value,
  onChange,
  sessions,
}: {
  value: string;
  onChange: (v: string) => void;
  sessions: ManagementSessionRow[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="sp-focus h-12 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 font-mono-nums text-xs text-[color:var(--ink)] outline-none focus:border-[color:var(--primary)]"
    >
      {sessions.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id.slice(0, 8)} · {s.class_name}
        </option>
      ))}
    </select>
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

function LegendSwatch({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "lowconf" | "suppressed";
  label: string;
}) {
  const swatch =
    tone === "ok"
      ? "bg-[color:var(--ok)]/70 border-[color:var(--ok)]/50"
      : tone === "warn"
        ? "bg-[color:var(--warn)]/70 border-[color:var(--warn)]/50"
        : tone === "lowconf"
          ? "border-[color:var(--warn)]/50"
          : "border-dashed border-[color:var(--muted)]/60 bg-[color:var(--surface)]";
  const style =
    tone === "lowconf"
      ? {
          backgroundImage:
            "repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in oklab, var(--warn) 45%, transparent) 4px 6px)",
        }
      : undefined;
  return (
    <div className="flex items-center gap-2">
      <span className={cn("inline-block h-3.5 w-6 rounded-sm border", swatch)} style={style} />
      <span className="font-mono-nums text-[11px] text-[color:var(--muted)]">{label}</span>
    </div>
  );
}
