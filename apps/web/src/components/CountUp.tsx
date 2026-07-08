import { useEffect, useRef, useState } from "react";

/** Animated count-up (design-system data style). Runs once per value change,
 *  ~220ms ease-out, and renders the final value immediately when the user
 *  prefers reduced motion. */
export function CountUp({
  value,
  decimals = 0,
  suffix = "",
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const shownRef = useRef(value); // last displayed value, for interrupted tweens

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fromRef.current = value;
      shownRef.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const dur = 220;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = from + (value - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    // If interrupted before completion, resume the next tween from where this
    // one actually stopped, not from the stale previous origin.
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = shownRef.current;
    };
  }, [value]);

  return (
    <span className="font-mono tabular-nums">
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
}
