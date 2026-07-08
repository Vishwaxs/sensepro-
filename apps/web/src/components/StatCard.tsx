import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { CountUp } from "@/components/CountUp";
import { cn } from "@/lib/utils";

/** KPI stat tile: mono uppercase label, count-up number, optional delta note. */
export function StatCard({
  label,
  value,
  icon: Icon,
  decimals = 0,
  suffix = "",
  note,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  decimals?: number;
  suffix?: string;
  note?: string;
  tone?: "default" | "ok" | "warn";
}) {
  return (
    <Card className="flex items-start gap-4 p-5">
      <div
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg border",
          tone === "ok" && "border-ok/30 bg-ok/10 text-ok",
          tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
          tone === "default" && "border-line bg-surface-2 text-primary",
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="font-mono text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
          {label}
        </div>
        <div className="mt-1 font-display text-[26px] leading-none font-800 text-ink">
          <CountUp value={value} decimals={decimals} suffix={suffix} />
        </div>
        {note && <div className="mt-1.5 truncate text-xs text-muted">{note}</div>}
      </div>
    </Card>
  );
}
