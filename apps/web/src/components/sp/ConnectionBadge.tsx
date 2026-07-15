import { cn } from "@/lib/utils";

export type ConnState = "LIVE" | "RECONNECTING" | "OFFLINE";

const cfg: Record<ConnState, { dot: string; label: string; ring: string }> = {
  LIVE: {
    dot: "bg-[color:var(--accent)]",
    label: "text-[color:var(--accent)]",
    ring: "shadow-[0_0_12px_rgba(34,211,238,0.75)]",
  },
  RECONNECTING: {
    dot: "bg-[color:var(--warn)]",
    label: "text-[color:var(--warn)]",
    ring: "shadow-[0_0_10px_rgba(251,191,36,0.55)]",
  },
  OFFLINE: { dot: "bg-[color:var(--muted)]", label: "text-[color:var(--muted)]", ring: "" },
};

export function ConnectionBadge({ state, className }: { state: ConnState; className?: string }) {
  const c = cfg[state];
  return (
    <div
      className={cn(
        "relative inline-flex items-center gap-2 rounded-md border border-[color:var(--line)]",
        "bg-gradient-to-b from-[color:var(--surface-2)]/85 to-[color:var(--surface-2)]/55",
        "px-3 py-1.5 font-mono-nums text-xs tracking-wider",
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05),0_2px_6px_-2px_rgba(11,17,32,0.5)]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-2 w-2 rounded-full transition-shadow",
          c.dot,
          c.ring,
          state === "LIVE" && "animate-[sensepro-pulse_1.6s_ease-in-out_infinite]",
        )}
      />
      <span className={cn("uppercase", c.label)}>{state}</span>
    </div>
  );
}
