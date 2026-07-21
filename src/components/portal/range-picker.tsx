"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RANGES, RANGE_LABELS, type RangeKey } from "@/lib/portal/range";
import { cn } from "@/lib/utils";

/** "Today ▾" date-range button. The range travels as a ?range= search param. */
export function RangePicker({ current }: { current: RangeKey }) {
  const pathname = usePathname();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="transition-smooth flex h-9 items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3.5 text-[13px] font-medium text-[var(--text-primary)] outline-none hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]">
        <Calendar className="size-3.5 text-[var(--text-secondary)]" />
        {RANGE_LABELS[current]}
        <ChevronDown className="size-3.5 text-[var(--text-muted)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {RANGES.map((range) => (
          <DropdownMenuItem key={range} asChild>
            <Link
              href={range === "today" ? pathname : `${pathname}?range=${range}`}
              className={cn(range === current && "text-[var(--accent-gold)]")}
            >
              {RANGE_LABELS[range]}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
