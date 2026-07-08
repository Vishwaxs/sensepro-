import type { ZoneAggregate } from "@/lib/types";

/** Camera coverage by zone: one horizontal strip, segment width ∝ visible
 *  students. Magnitude uses a single-hue sequential cobalt ramp (deepest =
 *  most visible); each segment carries a direct label, so meaning never
 *  rides on color alone. Suppressed zones (k < 5) render as a hatched
 *  muted segment with no numbers — the k-anonymity floor made visible. */

/* Sequential cobalt, dark by rank. All stops keep white labels above 4.5:1
   (6.7 / 8.7 / 10.4:1), so occupancy reads by both depth and legible number. */
const RAMP = ["#1D4ED8", "#1E40AF", "#1E3A8A"];

export function ZoneStrip({ zones }: { zones: ZoneAggregate[] }) {
  const total = zones.reduce((acc, z) => acc + (z.suppressed ? 0 : z.n_visible), 0);
  const ranked = [...zones].sort((a, b) => b.n_visible - a.n_visible);
  const colorOf = (z: ZoneAggregate) => RAMP[ranked.findIndex((r) => r.zone === z.zone)] ?? RAMP[2];

  return (
    <div>
      <div
        className="flex h-9 w-full gap-0.5 overflow-hidden rounded-lg"
        role="img"
        aria-label={`Visible students by zone: ${zones
          .map((z) => (z.suppressed ? `${z.zone} suppressed` : `${z.zone} ${z.n_visible}`))
          .join(", ")}`}
      >
        {zones.map((z) => {
          if (z.suppressed) {
            return (
              <div
                key={z.zone}
                className="grid shrink-0 basis-24 place-items-center bg-surface-2"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, transparent 0 6px, rgba(128,148,176,.25) 6px 8px)",
                }}
              >
                <span className="font-mono text-[10px] tracking-wider text-muted uppercase">
                  k&lt;5
                </span>
              </div>
            );
          }
          return (
            <div
              key={z.zone}
              className="grid min-w-16 place-items-center"
              style={{ width: `${(z.n_visible / Math.max(1, total)) * 100}%`, backgroundColor: colorOf(z) }}
            >
              <span className="font-mono text-[11px] font-medium text-white">
                {z.zone} · {z.n_visible}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 font-mono text-[11.5px] text-muted">
        {total} students visible to the camera · zones under k=5 are suppressed, never estimated
      </p>
    </div>
  );
}
