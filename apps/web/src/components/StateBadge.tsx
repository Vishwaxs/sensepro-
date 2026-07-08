import { CircleCheck, CircleHelp, CircleOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PresenceState } from "@/lib/types";

/** Presence state chip. Icon + label so state is never conveyed by
 *  color alone (a11y). PRESENT green / UNVERIFIED amber / ABSENT muted. */
export function StateBadge({ state }: { state: PresenceState }) {
  if (state === "PRESENT")
    return (
      <Badge tone="ok">
        <CircleCheck className="size-3" aria-hidden="true" /> PRESENT
      </Badge>
    );
  if (state === "UNVERIFIED")
    return (
      <Badge tone="warn">
        <CircleHelp className="size-3" aria-hidden="true" /> UNVERIFIED
      </Badge>
    );
  return (
    <Badge tone="muted">
      <CircleOff className="size-3" aria-hidden="true" /> ABSENT
    </Badge>
  );
}
