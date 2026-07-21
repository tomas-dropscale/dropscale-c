"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-2 text-sm text-[var(--text-primary)] transition-smooth",
        "placeholder:text-[var(--text-muted)]",
        "hover:border-[var(--border-strong)]",
        "focus-visible:border-[var(--accent-gold)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-[invalid=true]:border-[var(--danger-red)]/60 aria-[invalid=true]:focus-visible:ring-[var(--danger-red)]/15",
        "[color-scheme:dark]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full resize-y rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)] transition-smooth",
        "placeholder:text-[var(--text-muted)]",
        "hover:border-[var(--border-strong)]",
        "focus-visible:border-[var(--accent-gold)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "text-[13px] font-medium text-[var(--text-secondary)] select-none",
        className,
      )}
      {...props}
    />
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="text-[12px] text-[var(--danger-red)]">{children}</p>;
}
