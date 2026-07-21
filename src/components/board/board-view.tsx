"use client";

import * as React from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { AlertTriangle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AddColumn, BoardColumn } from "@/components/board/board-column";
import { BoardCardContent } from "@/components/board/board-card";
import { BoardFilters, EMPTY_FILTERS, type BoardFilterState } from "@/components/board/board-filters";
import { CardModal, type CardModalTarget } from "@/components/board/card-modal";
import { createClient } from "@/lib/supabase/client";
import { fetchBoardSnapshot, type BoardSnapshot } from "@/lib/board/queries";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import type { CardWithAssignees, ColumnWithCards, Profile } from "@/lib/supabase/types";

type DragOrigin = { columnId: string; index: number };

function findColumnOfCard(columns: ColumnWithCards[], cardId: string) {
  return columns.find((column) => column.cards.some((card) => card.id === cardId)) ?? null;
}

export function BoardView({
  snapshot,
  currentUser,
}: {
  snapshot: BoardSnapshot;
  currentUser: Profile;
}) {
  const { d } = useI18n();
  const [board, setBoard] = React.useState(snapshot.board);
  const [columns, setColumns] = React.useState<ColumnWithCards[]>(snapshot.columns);
  const [members, setMembers] = React.useState<Profile[]>(snapshot.members);
  const [commentCounts, setCommentCounts] = React.useState(snapshot.commentCounts);

  const [filters, setFilters] = React.useState<BoardFilterState>(EMPTY_FILTERS);
  const [modalTarget, setModalTarget] = React.useState<CardModalTarget | null>(null);
  const [activeCard, setActiveCard] = React.useState<CardWithAssignees | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const isAdmin = currentUser.role === "admin";

  // Drag state lives in refs: it changes on every pointer move and must not
  // trigger a re-render.
  const dragOriginRef = React.useRef<DragOrigin | null>(null);
  const snapshotBeforeDragRef = React.useRef<ColumnWithCards[] | null>(null);
  const draggingRef = React.useRef(false);
  const pendingRefreshRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const supabase = createClient();
    const next = await fetchBoardSnapshot(supabase);
    setBoard(next.board);
    setColumns(next.columns);
    setMembers(next.members);
    setCommentCounts(next.commentCounts);
  }, []);

  // ---------------------------------------------------------------------
  // Realtime: any change to the board tables re-reads the snapshot.
  // A debounced refetch is simpler and more robust than applying patches —
  // move_card touches several rows at once, and rebuilding that ordering on
  // the client would drift from the server.
  // ---------------------------------------------------------------------
  React.useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (draggingRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    };

    const channel = supabase
      .channel("dropscale-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "cards" }, scheduleRefresh)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_assignees" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "board_columns" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_comments" },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const sensors = useSensors(
    // 6px tolerance: distinguishes a click (open the card) from a drag
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ---------------------------------------------------------------------
  // Filters apply at render time only; state always holds the full board so
  // the persisted positions stay correct.
  // ---------------------------------------------------------------------
  const matchesFilters = React.useCallback(
    (card: CardWithAssignees) => {
      if (filters.onlyMine && !card.assignees.some((a) => a.id === currentUser.id)) return false;
      if (filters.memberId && !card.assignees.some((a) => a.id === filters.memberId)) return false;
      if (filters.priority && card.priority !== filters.priority) return false;
      return true;
    },
    [filters, currentUser.id],
  );

  const visibleColumns = React.useMemo(
    () => columns.map((column) => ({ ...column, cards: column.cards.filter(matchesFilters) })),
    [columns, matchesFilters],
  );

  const knownLabels = React.useMemo(
    () => [...new Set(columns.flatMap((column) => column.cards.flatMap((card) => card.labels)))],
    [columns],
  );

  const totalVisible = visibleColumns.reduce((sum, column) => sum + column.cards.length, 0);

  // ---------------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------------
  function handleDragStart(event: DragStartEvent) {
    const cardId = String(event.active.id);
    const column = findColumnOfCard(columns, cardId);
    if (!column) return;

    draggingRef.current = true;
    snapshotBeforeDragRef.current = columns;
    dragOriginRef.current = {
      columnId: column.id,
      index: column.cards.findIndex((card) => card.id === cardId),
    };
    setActiveCard(column.cards.find((card) => card.id === cardId) ?? null);
  }

  /** Moves across columns live so the card lands where the pointer is. */
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    setColumns((current) => {
      const sourceColumn = findColumnOfCard(current, activeId);
      if (!sourceColumn) return current;

      const targetColumn =
        current.find((column) => column.id === overId) ?? findColumnOfCard(current, overId);
      if (!targetColumn || targetColumn.id === sourceColumn.id) return current;

      const card = sourceColumn.cards.find((item) => item.id === activeId);
      if (!card) return current;

      const overIndex = targetColumn.cards.findIndex((item) => item.id === overId);
      const insertAt = overIndex === -1 ? targetColumn.cards.length : overIndex;

      return current.map((column) => {
        if (column.id === sourceColumn.id) {
          return { ...column, cards: column.cards.filter((item) => item.id !== activeId) };
        }
        if (column.id === targetColumn.id) {
          const next = [...column.cards];
          next.splice(insertAt, 0, { ...card, column_id: column.id });
          return { ...column, cards: next };
        }
        return column;
      });
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const activeId = String(active.id);

    const origin = dragOriginRef.current;
    const before = snapshotBeforeDragRef.current;

    draggingRef.current = false;
    dragOriginRef.current = null;
    snapshotBeforeDragRef.current = null;
    setActiveCard(null);

    const flushPending = () => {
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        void refresh();
      }
    };

    // Dropped outside any valid target → undo
    if (!over || !origin || !before) {
      if (before) setColumns(before);
      flushPending();
      return;
    }

    const overId = String(over.id);

    // Same-column reorder (cross-column was already handled in onDragOver)
    let nextColumns = columns;
    const sourceColumn = findColumnOfCard(columns, activeId);

    if (sourceColumn && activeId !== overId) {
      const oldIndex = sourceColumn.cards.findIndex((card) => card.id === activeId);
      const overIndex = sourceColumn.cards.findIndex((card) => card.id === overId);

      if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
        nextColumns = columns.map((column) =>
          column.id === sourceColumn.id
            ? { ...column, cards: arrayMove(column.cards, oldIndex, overIndex) }
            : column,
        );
        setColumns(nextColumns);
      }
    }

    const finalColumn = findColumnOfCard(nextColumns, activeId);
    if (!finalColumn) {
      flushPending();
      return;
    }

    const finalIndex = finalColumn.cards.findIndex((card) => card.id === activeId);

    if (finalColumn.id === origin.columnId && finalIndex === origin.index) {
      flushPending();
      return;
    }

    const supabase = createClient();
    const { error: moveError } = await supabase.rpc("move_card", {
      p_card_id: activeId,
      p_column_id: finalColumn.id,
      p_position: finalIndex,
    });

    if (moveError) {
      setError(fmt(d.board.errors.move, { message: moveError.message }));
      setColumns(before);
      pendingRefreshRef.current = false;
      await refresh();
      return;
    }

    // Remote changes that arrived mid-drag were deferred — apply them now
    flushPending();
  }

  // ---------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------
  async function createColumn(name: string) {
    if (!board) return;
    const supabase = createClient();

    const { error: insertError } = await supabase
      .from("board_columns")
      .insert({ board_id: board.id, name, position: columns.length });

    if (insertError) {
      setError(fmt(d.board.errors.createColumn, { message: insertError.message }));
      return;
    }
    await refresh();
  }

  async function renameColumn(columnId: string, name: string) {
    setColumns((current) =>
      current.map((column) => (column.id === columnId ? { ...column, name } : column)),
    );

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("board_columns")
      .update({ name })
      .eq("id", columnId);

    if (updateError) {
      setError(fmt(d.board.errors.renameColumn, { message: updateError.message }));
      await refresh();
    }
  }

  async function deleteColumn(columnId: string) {
    const column = columns.find((item) => item.id === columnId);
    const cardCount = column?.cards.length ?? 0;

    const confirmed = window.confirm(
      cardCount > 0
        ? fmt(d.board.confirm.deleteColumnWithCards, {
            column: column?.name ?? "",
            count: cardCount,
          })
        : fmt(d.board.confirm.deleteColumn, { column: column?.name ?? "" }),
    );
    if (!confirmed) return;

    const supabase = createClient();
    const { error: deleteError } = await supabase
      .from("board_columns")
      .delete()
      .eq("id", columnId);

    if (deleteError) {
      setError(fmt(d.board.errors.deleteColumn, { message: deleteError.message }));
      return;
    }
    await refresh();
  }

  if (!board) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="panel max-w-md p-6 text-center">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {d.board.noBoard}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {fmt(d.board.noBoardHelp, { file: "0003_seed_board.sql" })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-6 pb-4 md:px-7">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold tracking-tight text-[var(--text-primary)]">
            {d.board.title}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
            {board.name} ·{" "}
            {fmt(totalVisible === 1 ? d.board.storyCountOne : d.board.storyCount, {
              count: totalVisible,
            })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BoardFilters filters={filters} members={members} onChange={setFilters} />
          {columns.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setModalTarget({ mode: "create", columnId: columns[0].id })}
            >
              <Plus />
              {d.board.newStory}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="mx-5 mb-3 flex items-start gap-2 rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b] md:mx-7">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-[11px] underline underline-offset-2"
          >
            {d.common.close}
          </button>
        </div>
      )}

      {/* Horizontal scroll on small screens instead of breaking the layout */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-5 pb-5 md:px-7">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex h-full min-h-[320px] items-stretch gap-3">
            {visibleColumns.map((column) => (
              <BoardColumn
                key={column.id}
                column={column}
                cards={column.cards}
                commentCounts={commentCounts}
                canManage={isAdmin}
                onOpenCard={(card) => setModalTarget({ mode: "edit", card })}
                onCreateCard={(columnId) => setModalTarget({ mode: "create", columnId })}
                onRenameColumn={(columnId, name) => void renameColumn(columnId, name)}
                onDeleteColumn={(columnId) => void deleteColumn(columnId)}
              />
            ))}

            {isAdmin && <AddColumn onAdd={(name) => void createColumn(name)} />}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeCard ? (
              <div className="w-[266px] rotate-1">
                <BoardCardContent
                  card={activeCard}
                  commentCount={commentCounts[activeCard.id]}
                  dragging
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <CardModal
        target={modalTarget}
        members={members}
        knownLabels={knownLabels}
        currentUserId={currentUser.id}
        canDelete={
          isAdmin ||
          (modalTarget?.mode === "edit" && modalTarget.card.created_by === currentUser.id)
        }
        onClose={() => setModalTarget(null)}
        onSaved={refresh}
      />
    </div>
  );
}
