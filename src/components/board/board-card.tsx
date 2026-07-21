"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, MessageSquare } from "lucide-react";

import { AvatarStack } from "@/components/ui/avatar";
import { PRIORITY_BADGE, priorityLabel } from "@/lib/board/config";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { CardWithAssignees } from "@/lib/supabase/types";

/** "2026-07-24" → "24 Jul" without the browser timezone shifting the day. */
function formatDue(due: string, intl: string) {
  const [year, month, day] = due.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(intl, {
    day: "2-digit",
    month: "short",
  });
}

function isOverdue(due: string) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return due < todayKey;
}

export function BoardCardContent({
  card,
  commentCount,
  dragging,
  className,
}: {
  card: CardWithAssignees;
  commentCount?: number;
  dragging?: boolean;
  className?: string;
}) {
  const { d, intl } = useI18n();
  const overdue = card.due_date ? isOverdue(card.due_date) : false;

  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3 transition-smooth",
        "hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]",
        dragging && "border-[var(--accent-gold)]/40 shadow-2xl shadow-black/50",
        className,
      )}
    >
      <p className="text-[13px] leading-snug font-medium text-balance text-[var(--text-primary)]">
        {card.title}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] leading-none font-medium",
            PRIORITY_BADGE[card.priority],
          )}
        >
          {priorityLabel(d, card.priority)}
        </span>

        {card.labels.map((label) => (
          <span
            key={label}
            className="inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] leading-none text-[var(--text-secondary)]"
          >
            {label}
          </span>
        ))}
      </div>

      {(card.due_date || card.assignees.length > 0 || commentCount) && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            {card.due_date && (
              <span
                className={cn(
                  "flex items-center gap-1 text-[11px]",
                  overdue ? "font-medium text-[var(--danger-red)]" : "text-[var(--text-secondary)]",
                )}
              >
                <CalendarDays className="size-3" aria-hidden />
                {formatDue(card.due_date, intl)}
              </span>
            )}

            {Boolean(commentCount) && (
              <span className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                <MessageSquare className="size-3" aria-hidden />
                {commentCount}
              </span>
            )}
          </div>

          <AvatarStack people={card.assignees} max={3} size="xs" />
        </div>
      )}
    </div>
  );
}

export function SortableBoardCard({
  card,
  commentCount,
  onOpen,
}: {
  card: CardWithAssignees;
  commentCount?: number;
  onOpen: (card: CardWithAssignees) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId: card.column_id },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("list-none", isDragging && "opacity-35")}
    >
      <button
        type="button"
        onClick={() => onOpen(card)}
        className="w-full cursor-grab text-left outline-none active:cursor-grabbing focus-visible:rounded-xl focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
        {...attributes}
        {...listeners}
      >
        <BoardCardContent card={card} commentCount={commentCount} />
      </button>
    </li>
  );
}
