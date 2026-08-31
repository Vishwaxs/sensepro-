import type { ZoneAggregateRow } from "@/lib/data/engagement";
import { latestWindow } from "@/lib/data/engagement";
import { cn } from "@/lib/utils";

function Badge({ tone, children }: { tone: "warn" | "muted" | "ok"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-md border px-2 py-0.5 font-mono-nums text-[10px] uppercase tracking-wider",
        tone === "warn" &&
          "border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]",
        tone === "muted" &&
          "border-[color:var(--muted)]/40 bg-[color:var(--surface)] text-[color:var(--muted)]",
        tone === "ok" &&
          "border-[color:var(--ok)]/40 bg-[color:var(--ok)]/10 text-[color:var(--ok)]",
      )}
    >
      {children}
    </span>
  );
}

/** Live VNEI by zone with the honesty devices attached: every bar carries a
 *  coverage badge, coverage under 50% renders hatched LOW-CONFIDENCE, and a
 *  zone with no row is shown as withheld because absence alone cannot identify
 *  which observability or persistence gate applied. Trend renders as one sparkline
 *  per zone (small multiples), so meaning never rides on series color. */

const ZONES: Array<"front" | "mid" | "back"> = ["front", "mid", "back"];

const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(45deg, transparent 0 6px, rgba(128,148,176,.25) 6px 8px)",
};

function ZoneBar({ row }: { row: ZoneAggregateRow | undefined }) {
  if (!row) {
    return (
      <div
        className="grid h-9 place-items-center rounded-lg bg-surface-2"
        style={HATCH}
        role="img"
        aria-label="withheld: no reportable aggregate for this zone"
      >
        <span className="font-mono text-[10.5px] tracking-wider text-muted uppercase">
          withheld · no reportable row
        </span>
      </div>
    );
  }
  const lowConfidence = row.coverage < 0.5;
  const coverageTone = row.coverage >= 0.7 ? "ok" : "warn";
  const coverageLabel =
    row.coverage >= 0.7 ? "strong coverage" : row.coverage >= 0.5 ? "caution" : "low confidence";
  const pct = Math.round(row.vnei * 100);
  return (
    <div>
      <div
        className="relative h-9 overflow-hidden rounded-lg bg-surface-2"
        role="img"
        aria-label={`VNEI ${pct} percent, coverage ${Math.round(row.coverage * 100)} percent, ${row.n_tracked} tracked`}
      >
        <div
          className="grid h-full place-items-end rounded-lg bg-primary"
          style={{ width: `${pct}%`, ...(lowConfidence ? HATCH : {}) }}
        />
        <span className="absolute inset-y-0 left-3 grid place-items-center font-mono text-[12px] font-medium text-white drop-shadow-sm">
          {pct}%
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={coverageTone}>
          coverage {Math.round(row.coverage * 100)}% · {coverageLabel}
        </Badge>
        <Badge tone="muted">
          {row.n_tracked} peak tracks · roster {row.enrolled_in_zone}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <SignalValue label="Head down" value={row.signals.head_down_rate} />
        <SignalValue label="Device" value={row.signals.phone_rate} />
        <SignalValue label="Stillness" value={row.signals.still_rate} />
      </div>
    </div>
  );
}

function SignalValue({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] px-2 py-1.5">
      <div className="font-mono-nums text-[9px] uppercase tracking-wider text-[color:var(--muted)]">
        {label}
      </div>
      <div className="mt-0.5 font-mono-nums text-[11px] text-[color:var(--ink)]">
        {typeof value === "number" ? `${Math.round(value * 100)}%` : "Unavailable"}
      </div>
    </div>
  );
}

function Sparkline({ zone, rows }: { zone: string; rows: ZoneAggregateRow[] }) {
  const W = 200;
  const H = 36;
  const windows = [...new Set(rows.map((row) => row.window_start))].sort();
  const zoneByWindow = new Map(
    rows.filter((row) => row.zone === zone).map((row) => [row.window_start, row]),
  );
  const reported = windows
    .map((windowStart, index) => {
      const row = zoneByWindow.get(windowStart);
      if (!row) return null;
      const x = windows.length === 1 ? W / 2 : (index * W) / (windows.length - 1);
      return { x, y: H - row.vnei * (H - 4) - 2, row };
    })
    .filter((point): point is NonNullable<typeof point> => point !== null);

  if (reported.length < 2) {
    return (
      <p className="font-mono text-[11px] text-muted">trend appears after two or more windows</p>
    );
  }

  const segments: Array<typeof reported> = [];
  let current: typeof reported = [];
  for (const windowStart of windows) {
    const point = reported.find((candidate) => candidate.row.window_start === windowStart);
    if (point) {
      current.push(point);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  const last = reported[reported.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-9 w-full"
      role="img"
      aria-label={`${zone} VNEI reported in ${reported.length} of ${windows.length} retained windows, latest ${Math.round(last.row.vnei * 100)} percent`}
    >
      {segments.map((segment, index) =>
        segment.length > 1 ? (
          <polyline
            key={index}
            points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
          />
        ) : null,
      )}
      {reported.map((point) => (
        <circle
          key={point.row.window_start}
          cx={point.x}
          cy={point.y}
          r={2.25}
          fill="var(--primary)"
        />
      ))}
    </svg>
  );
}

export function VneiPanel({ rows }: { rows: ZoneAggregateRow[] }) {
  const { windowStart, byZone } = latestWindow(rows);
  return (
    <div>
      <p className="mb-3 font-mono text-[11.5px] text-muted">
        {windowStart
          ? `latest window · ${new Date(windowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "no windows recorded yet"}
      </p>
      <div className="flex flex-col gap-4">
        {ZONES.map((zone) => (
          <div key={zone} className="grid items-center gap-3 sm:grid-cols-[64px_1fr_200px]">
            <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">
              {zone}
            </span>
            <ZoneBar row={byZone.get(zone)} />
            <Sparkline zone={zone} rows={rows} />
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[11.5px] text-muted">
        VNEI normalises by who the camera actually saw; coverage declares how much that was.
        Suppressed windows are withheld, never estimated.
      </p>
    </div>
  );
}
