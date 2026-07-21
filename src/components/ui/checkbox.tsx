"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer size-4 shrink-0 rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-panel)] transition-smooth",
        "hover:border-[var(--accent-gold)]/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/25",
        "data-[state=checked]:border-[var(--accent-gold)] data-[state=checked]:bg-[var(--accent-gold)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[#1a1409]">
        <Check className="size-3 stroke-[3]" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
