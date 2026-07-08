import { cn } from "@/lib/utils";

/** Small pulsing dot for "live" (design-system data style). */
export function LiveDot({ tone = "accent", className }: { tone?: "accent" | "ok" | "bad"; className?: string }) {
  const color = tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-bad" : "bg-accent";
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden="true">
      <span className={cn("absolute inline-flex size-full rounded-full opacity-60 animate-pulse-dot", color)} />
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}
