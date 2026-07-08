import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

const tones: Record<Tone, string> = {
  ok: "bg-ok/15 text-ok border-ok/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  bad: "bg-bad/15 text-bad border-bad/30",
  muted: "bg-surface-2 text-muted border-line",
  accent: "bg-accent/10 text-accent border-accent/30",
};

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ className, tone = "muted", ...props }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5",
        "font-mono text-[11px] font-medium tracking-wide",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
