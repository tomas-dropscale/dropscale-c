"use client";

import * as React from "react";
import { Check, Tag, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUGGESTED_LABELS } from "@/lib/board/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LabelSelector({
  value,
  known,
  onChange,
}: {
  value: string[];
  /** Labels already used on other cards in this board, to encourage reuse. */
  known: string[];
  onChange: (labels: string[]) => void;
}) {
  const { d, intl } = useI18n();
  const [draft, setDraft] = React.useState("");

  const options = React.useMemo(() => {
    const set = new Set<string>([...SUGGESTED_LABELS, ...known, ...value]);
    return [...set].sort((a, b) => a.localeCompare(b, intl));
  }, [known, value, intl]);

  function toggle(label: string) {
    onChange(value.includes(label) ? value.filter((item) => item !== label) : [...value, label]);
  }

  function addDraft() {
    const label = draft.trim().toLowerCase();
    if (!label || value.includes(label)) {
      setDraft("");
      return;
    }
    onChange([...value, label]);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((label) => (
        <span
          key={label}
          className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-0.5 pr-1 pl-2.5 text-[11.5px] text-[var(--text-secondary)]"
        >
          {label}
          <button
            type="button"
            onClick={() => toggle(label)}
            aria-label={fmt(d.board.modal.removeLabel, { label })}
            className="rounded-full p-0.5 transition-smooth hover:bg-[var(--danger-red)]/15 hover:text-[var(--danger-red)]"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border border-dashed border-[var(--border-strong)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-smooth outline-none hover:border-[var(--accent-gold)]/40 hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30">
          <Tag className="size-3.5" aria-hidden />
          {d.board.modal.labels}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="min-w-[230px]">
          <DropdownMenuLabel>{d.board.modal.labels}</DropdownMenuLabel>

          <div className="px-1.5 pb-1.5">
            <Input
              value={draft}
              placeholder={d.board.modal.newLabel}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDraft();
                }
              }}
              className="h-8 text-[12.5px]"
            />
          </div>

          <DropdownMenuSeparator />

          <div className="max-h-56 overflow-y-auto">
            {options.map((label) => {
              const active = value.includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggle(label)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-smooth hover:bg-[var(--bg-panel-hover)]"
                >
                  {label}
                  <Check
                    className={cn(
                      "size-3.5 shrink-0 text-[var(--accent-gold)] transition-smooth",
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
