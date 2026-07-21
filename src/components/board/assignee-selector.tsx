"use client";

import * as React from "react";
import { Check, UserPlus } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/supabase/types";

export function AssigneeSelector({
  members,
  selectedIds,
  onToggle,
}: {
  members: Profile[];
  selectedIds: string[];
  onToggle: (userId: string) => void;
}) {
  const { d } = useI18n();
  const selected = members.filter((member) => selectedIds.includes(member.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((member) => (
        <button
          key={member.id}
          type="button"
          onClick={() => onToggle(member.id)}
          title={fmt(d.board.modal.removeAssignee, { name: member.full_name })}
          className="flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-0.5 pr-2.5 pl-0.5 text-[12px] text-[var(--text-primary)] transition-smooth hover:border-[var(--danger-red)]/40"
        >
          <Avatar name={member.full_name} src={member.avatar_url} seed={member.id} size="xs" />
          <span className="max-w-[120px] truncate">{member.full_name}</span>
        </button>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border border-dashed border-[var(--border-strong)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-smooth outline-none hover:border-[var(--accent-gold)]/40 hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30">
          <UserPlus className="size-3.5" aria-hidden />
          {selected.length === 0 ? d.board.modal.assign : d.board.modal.addAssignee}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="min-w-[240px]">
          <DropdownMenuLabel>{d.board.modal.team}</DropdownMenuLabel>
          <DropdownMenuSeparator />

          <div className="max-h-64 overflow-y-auto">
            {members.length === 0 && (
              <p className="px-2.5 py-3 text-[12.5px] text-[var(--text-muted)]">
                {d.board.modal.noMembers}
              </p>
            )}

            {members.map((member) => {
              const active = selectedIds.includes(member.id);

              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => onToggle(member.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-smooth hover:bg-[var(--bg-panel-hover)]"
                >
                  <Avatar
                    name={member.full_name}
                    src={member.avatar_url}
                    seed={member.id}
                    size="md"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[var(--text-primary)]">
                      {member.full_name}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--text-secondary)]">
                      {member.email}
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0 text-[var(--accent-gold)] transition-smooth",
                      active ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
