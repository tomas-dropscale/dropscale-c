"use client";

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Check, MoreHorizontal, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SortableBoardCard } from "@/components/board/board-card";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CardWithAssignees, ColumnWithCards } from "@/lib/supabase/types";

export function BoardColumn({
  column,
  cards,
  commentCounts,
  canManage,
  onOpenCard,
  onCreateCard,
  onRenameColumn,
  onDeleteColumn,
}: {
  column: ColumnWithCards;
  cards: CardWithAssignees[];
  commentCounts: Record<string, number>;
  canManage: boolean;
  onOpenCard: (card: CardWithAssignees) => void;
  onCreateCard: (columnId: string) => void;
  onRenameColumn: (columnId: string, name: string) => void;
  onDeleteColumn: (columnId: string) => void;
}) {
  const { d } = useI18n();
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState(column.name);

  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: "column", columnId: column.id },
  });

  function commitRename() {
    const name = draft.trim();
    if (name && name !== column.name) onRenameColumn(column.id, name);
    setRenaming(false);
  }

  return (
    <section
      className={cn(
        "flex w-[290px] shrink-0 flex-col rounded-[var(--radius-card)] border bg-[var(--bg-panel)]/45 transition-smooth",
        isOver ? "border-[var(--accent-gold)]/35" : "border-[var(--border-subtle)]",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        {renaming ? (
          <div className="flex flex-1 items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") {
                  setDraft(column.name);
                  setRenaming(false);
                }
              }}
              className="h-7 text-[12.5px]"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={commitRename}
              aria-label={d.board.saveName}
            >
              <Check />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setDraft(column.name);
                setRenaming(false);
              }}
              aria-label={d.common.cancel}
            >
              <X />
            </Button>
          </div>
        ) : (
          <>
            <h2 className="flex min-w-0 items-baseline gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
              <span className="truncate">{column.name}</span>
              <span className="shrink-0 text-[11.5px] font-normal text-[var(--text-muted)]">
                · {cards.length}
              </span>
            </h2>

            <div className="flex shrink-0 items-center">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => onCreateCard(column.id)}
                aria-label={fmt(d.board.newStoryIn, { column: column.name })}
              >
                <Plus />
              </Button>

              {canManage && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={fmt(d.board.columnOptions, { column: column.name })}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(true)}>
                      {d.board.renameColumn}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="danger"
                      onSelect={() => onDeleteColumn(column.id)}
                    >
                      <Trash2 aria-hidden />
                      {d.board.deleteColumn}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </>
        )}
      </header>

      <div ref={setNodeRef} className="min-h-[80px] flex-1 overflow-y-auto px-2.5 pb-2.5">
        <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-2">
            {cards.map((card) => (
              <SortableBoardCard
                key={card.id}
                card={card}
                commentCount={commentCounts[card.id]}
                onOpen={onOpenCard}
              />
            ))}
          </ul>
        </SortableContext>

        {cards.length === 0 && (
          <p className="px-1 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {d.board.emptyColumn}
          </p>
        )}
      </div>

      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          onClick={() => onCreateCard(column.id)}
          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-[var(--text-secondary)] transition-smooth hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)]"
        >
          <Plus className="size-3.5" aria-hidden />
          {d.board.newStory}
        </button>
      </div>
    </section>
  );
}

export function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const { d } = useI18n();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setName("");
    setAdding(false);
  }

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex h-fit w-[290px] shrink-0 items-center gap-1.5 rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] px-3 py-3 text-[12.5px] text-[var(--text-secondary)] transition-smooth hover:border-[var(--accent-gold)]/40 hover:text-[var(--text-primary)]"
      >
        <Plus className="size-4" aria-hidden />
        {d.board.addColumn}
      </button>
    );
  }

  return (
    <div className="flex h-fit w-[290px] shrink-0 flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-2.5">
      <Input
        autoFocus
        value={name}
        placeholder={d.board.columnName}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") setAdding(false);
        }}
        className="h-8 text-[13px]"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={submit}>
          {d.board.add}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
          {d.common.cancel}
        </Button>
      </div>
    </div>
  );
}
