"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium transition-smooth outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--accent-gold)] text-[#1a1409] font-semibold hover:bg-[var(--accent-gold-strong)] active:scale-[0.99]",
        secondary:
          "bg-[var(--bg-panel)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-panel-hover)] hover:border-[var(--border-strong)]",
        ghost:
          "text-[var(--text-secondary)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)]",
        outline:
          "border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--bg-panel)]",
        danger:
          "bg-transparent border border-[var(--danger-red)]/40 text-[var(--danger-red)] hover:bg-[var(--danger-red)]/10",
      },
      size: {
        sm: "h-8 px-3 text-[13px] [&_svg]:size-3.5",
        md: "h-10 px-4 [&_svg]:size-4",
        lg: "h-11 px-5 [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { buttonVariants };
