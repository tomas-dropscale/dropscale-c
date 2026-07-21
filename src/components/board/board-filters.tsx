"use client";

import { ChevronDown, Filter, X } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIORITIES, PRIORITY_DOT, priorityLabel } from "@/lib/board/config";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { Priority, Profile } from "@/lib/supabase/types";

export type BoardFilterState = {
  onlyMine: boolean;
  memberId: string | null;
  priority: Priority | null;
};

export const EMPTY_FILTERS: BoardFilterState = {
  onlyMine: false,
  memberId: null,
  priority: null,
};

export function BoardFilters({
  filters,
  members,
  onChange,
}: {
  filters: BoardFilterState;
  members: Profile[];
  onChange: (filters: BoardFilterState) => void;
}) {
  const { d } = useI18n();
  const selectedMember = members.find((member) => member.id === filters.memberId) ?? null;
  const active = filters.onlyMine || filters.memberId !== null || filters.priority !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={filters.onlyMine}
        onClick={() => onChange({ ...filters, onlyMine: !filters.onlyMine, memberId: null })}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-smooth",
          filters.onlyMine
            ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
            : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
        )}
      >
        <Filter className="size-3.5" aria-hidden />
        {d.board.filters.assignedToMe}
      </button>

      {/* Member filter */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-smooth outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30",
            selectedMember
              ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
              : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
          )}
        >
          {selectedMember ? (
            <>
              <Avatar
                name={selectedMember.full_name}
                src={selectedMember.avatar_url}
                seed={selectedMember.id}
                size="xs"
              />
              <span className="max-w-[110px] truncate">{selectedMember.full_name}</span>
            </>
          ) : (
            d.board.filters.member
          )}
          <ChevronDown className="size-3" aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="min-w-[220px]">
          <DropdownMenuLabel>{d.board.filters.filterByMember}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange({ ...filters, memberId: null })}>
            {d.board.filters.allMembers}
          </DropdownMenuItem>
          {members.map((member) => (
            <DropdownMenuItem
              key={member.id}
              onSelect={() => onChange({ ...filters, memberId: member.id, onlyMine: false })}
            >
              <Avatar
                name={member.full_name}
                src={member.avatar_url}
                seed={member.id}
                size="xs"
              />
              <span className="truncate">{member.full_name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Priority filter */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-smooth outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30",
            filters.priority
              ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
              : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
          )}
        >
          {filters.priority ? (
            <>
              <span className={cn("size-2 rounded-full", PRIORITY_DOT[filters.priority])} />
              {priorityLabel(d, filters.priority)}
            </>
          ) : (
            d.board.filters.priority
          )}
          <ChevronDown className="size-3" aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{d.board.filters.filterByPriority}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange({ ...filters, priority: null })}>
            {d.common.all}
          </DropdownMenuItem>
          {PRIORITIES.map((priority) => (
            <DropdownMenuItem key={priority} onSelect={() => onChange({ ...filters, priority })}>
              <span className={cn("size-2 rounded-full", PRIORITY_DOT[priority])} />
              {priorityLabel(d, priority)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-[var(--text-muted)] transition-smooth hover:text-[var(--text-primary)]"
        >
          <X className="size-3.5" aria-hidden />
          {d.common.clear}
        </button>
      )}
    </div>
  );
}
