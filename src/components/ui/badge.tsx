import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap transition-smooth",
  {
    variants: {
      variant: {
        neutral:
          "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
        gold: "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]",
        success: "border-[var(--success-green)]/25 bg-[var(--success-green)]/12 text-[var(--success-green)]",
        warning: "border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/12 text-[var(--warning-orange)]",
        danger: "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/12 text-[var(--danger-red)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
