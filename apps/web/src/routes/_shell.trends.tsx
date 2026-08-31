import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  AreaChart,
  Area,
} from "recharts";
import { guardRoute } from "@/lib/auth-guard";
import { fetchTrendSeries } from "@/lib/data/live";
import type { TrendPoint } from "@/lib/data/live";
import { GaugeCircle, RefreshCw, WifiOff } from "lucide-react";

export const Route = createFileRoute("/_shell/trends")({
  beforeLoad: guardRoute(["management"]),
  head: () => ({
    meta: [{ title: "Trends · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: TrendsPage,
});

const tooltipStyle = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink)",
  fontFamily: "IBM Plex Mono",
  fontSize: 12,
} as const;

function parseLocalDay(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function shortDate(date: string): string {
  return parseLocalDay(date).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fullDate(date: string): string {
  return parseLocalDay(date).toLocaleDateString([], { dateStyle: "full" });
}

function percent(value: number | null): string {
  return value === null ? "Withheld" : `${Math.round(value * 100)}%`;
}

function TrendsPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [days, setDays] = useState<TrendPoint[]>([]);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoad("loading");
    fetchTrendSeries(14, "workshop")
      .then((points) => {
        if (mounted) {
          setDays(points);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (mounted) setLoad("error");
      });
    return () => {
      mounted = false;
    };
  }, [retryRevision]);

  const hasVnei = days.some((d) => d.vnei !== null);
  const hasCoverage = days.some((d) => d.coverage !== null);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
            Workshops · last 14 days
          </div>
          <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
            Aggregate trends
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Class and zone-level behavioural signals only. No participant identity, emotion label,
            or individual engagement score is used.
          </p>
        </div>
        {load === "ready" ? (
          <button
            type="button"
            onClick={() => setRetryRevision((revision) => revision + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 font-mono-nums text-[11px] uppercase tracking-wider text-[color:var(--muted)] transition-colors hover:border-[color:var(--primary)] hover:text-[color:var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        ) : null}
      </header>

      {load === "loading" ? (
        <div className="glass-panel grid h-56 place-items-center font-mono text-[12.5px] text-[color:var(--muted)]">
          loading…
        </div>
      ) : load === "error" ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-3 py-16 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load trend data
          </div>
          <p className="text-sm">No retained values are shown as current.</p>
          <button
            type="button"
            onClick={() => setRetryRevision((revision) => revision + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[color:var(--primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--primary-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : days.length === 0 ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
          <GaugeCircle className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            No sessions in the last 14 days
          </div>
          <p className="text-sm">Trends appear once at least one session has run and ended.</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <ChartCard title="Workshop VNEI">
            {!hasVnei ? (
              <NoVneiNote />
            ) : (
              <ResponsiveContainer>
                <LineChart
                  accessibilityLayer
                  data={days}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 4" vertical={false} />
                  <XAxis
                    dataKey="date"
                    minTickGap={24}
                    tickFormatter={shortDate}
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
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: "var(--muted)" }}
                    labelFormatter={(label) => fullDate(String(label))}
                    formatter={(value) => [`${Math.round(Number(value) * 100)}%`, "VNEI"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="vnei"
                    stroke="var(--primary)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "var(--primary)" }}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Coverage within reportable zones">
            {!hasCoverage ? (
              <div className="grid h-full place-items-center text-center text-sm text-[color:var(--muted)]">
                No reportable workshop coverage yet.
              </div>
            ) : (
              <ResponsiveContainer>
                <AreaChart
                  accessibilityLayer
                  data={days}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--ok)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--ok)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 4" vertical={false} />
                  <XAxis
                    dataKey="date"
                    minTickGap={24}
                    tickFormatter={shortDate}
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
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: "var(--muted)" }}
                    labelFormatter={(label) => fullDate(String(label))}
                    formatter={(value) => [`${Math.round(Number(value) * 100)}%`, "Coverage"]}
                  />
                  <Area
                    dataKey="coverage"
                    stroke="var(--ok)"
                    strokeWidth={2}
                    fill="url(#g1)"
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <div className="glass-panel p-5 sm:p-6">
            <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
              Section notes
            </div>
            <h3 className="mt-1 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              What "coverage" means
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-[color:var(--muted)]">
              Coverage compares peak anonymous, pose-observable face tracks with the configured
              roster inside aggregates that passed reporting gates. Suppressed zones do not
              contribute, so this is not whole-room attendance or a count of verified students. A
              missing day remains a gap rather than an estimated zero.
            </p>
          </div>

          <section className="glass-panel overflow-hidden lg:col-span-2">
            <div className="border-b border-[color:var(--line)] px-5 py-4 sm:px-6">
              <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
                Accessible data view
              </div>
              <h3 className="mt-1 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
                Daily reported values
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <caption className="sr-only">
                  Workshop VNEI and reportable-zone coverage for the last 14 days
                </caption>
                <thead className="bg-[color:var(--surface-2)]">
                  <tr className="font-mono-nums text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                    <th className="px-5 py-2.5 font-medium sm:px-6">Local date</th>
                    <th className="px-4 py-2.5 text-right font-medium">VNEI</th>
                    <th className="px-5 py-2.5 text-right font-medium sm:px-6">
                      Coverage in reportable zones
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr
                      key={day.date}
                      className="border-t border-[color:var(--line)] text-xs text-[color:var(--ink)]"
                    >
                      <td className="px-5 py-3 sm:px-6">{fullDate(day.date)}</td>
                      <td className="px-4 py-3 text-right font-mono-nums">{percent(day.vnei)}</td>
                      <td className="px-5 py-3 text-right font-mono-nums sm:px-6">
                        {percent(day.coverage)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function NoVneiNote() {
  return (
    <div className="grid h-full place-items-center text-center text-sm text-[color:var(--muted)]">
      No VNEI recorded yet — workshop engagement appears only after privacy and pose-observability
      requirements are met.
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel p-5 sm:p-6">
      <h3 className="mb-3 font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
        {title}
      </h3>
      <div className="h-56">{children}</div>
    </div>
  );
}
