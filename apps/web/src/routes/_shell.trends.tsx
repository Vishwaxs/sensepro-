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
import { GaugeCircle, WifiOff } from "lucide-react";

export const Route = createFileRoute("/_shell/trends")({
  beforeLoad: guardRoute(["management"]),
  head: () => ({
    meta: [{ title: "Trends · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: TrendsPage,
});

const tooltipStyle = {
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  fontFamily: "IBM Plex Mono",
  fontSize: 12,
} as const;

function TrendsPage() {
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [days, setDays] = useState<TrendPoint[]>([]);

  useEffect(() => {
    let mounted = true;
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
  }, []);

  const hasVnei = days.some((d) => d.vnei !== null);
  const hasCoverage = days.some((d) => d.coverage !== null);

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
          Section 14 days
        </div>
        <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
          Aggregate trends
        </h2>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          Class-level workshop engagement and camera coverage over the last two weeks. Never per
          student, never emotion.
        </p>
      </header>

      {load === "loading" ? (
        <div className="glass-panel grid h-56 place-items-center font-mono text-[12.5px] text-[color:var(--muted)]">
          loading…
        </div>
      ) : load === "error" ? (
        <div className="glass-panel flex flex-col items-center justify-center gap-2 py-16 text-center text-[color:var(--muted)]">
          <WifiOff className="h-8 w-8 opacity-50" />
          <div className="font-display text-lg font-medium text-[color:var(--ink)]">
            Could not load trend data
          </div>
          <p className="text-sm">Check your connection and role, then refresh.</p>
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
          <ChartCard title="Workshop VNEI" color="var(--primary)">
            {!hasVnei ? (
              <NoVneiNote />
            ) : (
              <ResponsiveContainer>
                <LineChart data={days} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="var(--muted)"
                    tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                  />
                  <YAxis
                    stroke="var(--muted)"
                    tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                    domain={[0, 1]}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line
                    type="monotone"
                    dataKey="vnei"
                    stroke="var(--primary)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "var(--primary)" }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Observable camera coverage" color="var(--ok)">
            {!hasCoverage ? (
              <div className="grid h-full place-items-center text-center text-sm text-[color:var(--muted)]">
                No reportable workshop coverage yet.
              </div>
            ) : (
              <ResponsiveContainer>
                <AreaChart data={days} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--ok)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--ok)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="var(--muted)"
                    tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                  />
                  <YAxis
                    stroke="var(--muted)"
                    tick={{ fontFamily: "IBM Plex Mono", fontSize: 11 }}
                    domain={[0, 1]}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area
                    dataKey="coverage"
                    stroke="var(--ok)"
                    strokeWidth={2}
                    fill="url(#g1)"
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <div className="glass-panel p-6">
            <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
              Section notes
            </div>
            <h3 className="mt-1 font-display text-xl font-extrabold tracking-tight text-[color:var(--ink)]">
              What "coverage" means
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-[color:var(--muted)]">
              Coverage is the fraction of enrolled, consented students the classroom camera can
              actually see during a session. A day with no engagement windows recorded shows a gap
              in the VNEI line rather than an invented value — the model refuses to pretend it sees
              what it doesn't.
            </p>
          </div>
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

function ChartCard({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-panel p-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-lg font-extrabold tracking-tight text-[color:var(--ink)]">
          {title}
        </h3>
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: color, boxShadow: `0 0 12px ${color}` }}
        />
      </div>
      <div className="h-56">{children}</div>
    </div>
  );
}
