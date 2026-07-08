import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-full border border-line bg-surface-2">
        <Icon className="size-5 text-muted" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-muted">{hint}</p>}
    </div>
  );
}
