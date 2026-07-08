import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-primary text-white hover:bg-primary-deep active:bg-primary-deep border border-transparent",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-surface-2 border border-transparent",
  outline: "bg-transparent text-ink border border-line hover:border-primary hover:text-primary",
  danger: "bg-transparent text-bad border border-line hover:border-bad",
};

/* min-h keeps every button >= 44px touch target (a11y) */
const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3 text-[13px]",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-[15px]",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = "primary", size = "md", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-medium",
        "transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
