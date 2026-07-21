"use client";

import * as React from "react";
import { CalendarDays, Loader2, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { AssigneeSelector } from "@/components/board/assignee-selector";
import { LabelSelector } from "@/components/board/label-selector";
import { createClient } from "@/lib/supabase/client";
import { PRIORITIES, PRIORITY_DOT, priorityLabel } from "@/lib/board/config";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type {
  CardWithAssignees,
  CommentWithAuthor,
  Priority,
  Profile,
} from "@/lib/supabase/types";

export type CardModalTarget =
  | { mode: "create"; columnId: string }
  | { mode: "edit"; card: CardWithAssignees };

type Draft = {
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
  dueDate: string;
  assigneeIds: string[];
};

function draftFrom(target: CardModalTarget): Draft {
  if (target.mode === "create") {
    return {
      title: "",
      description: "",
      priority: "medium",
      labels: [],
      dueDate: "",
      assigneeIds: [],
    };
  }

  const { card } = target;
  return {
    title: card.title,
    description: card.description ?? "",
    priority: card.priority,
    labels: card.labels,
    dueDate: card.due_date ?? "",
    assigneeIds: card.assignees.map((assignee) => assignee.id),
  };
}

type CardModalProps = {
  target: CardModalTarget | null;
  members: Profile[];
  knownLabels: string[];
  currentUserId: string;
  canDelete: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

export function CardModal({ target, onClose, ...rest }: CardModalProps) {
  // The `key` remounts the modal body when the target changes, which resets
  // the form without syncing state inside an effect.
  const instanceKey =
    target === null
      ? "none"
      : target.mode === "edit"
        ? `edit:${target.card.id}`
        : `create:${target.columnId}`;

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        {target && (
          <CardModalBody key={instanceKey} target={target} onClose={onClose} {...rest} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CardModalBody({
  target,
  members,
  knownLabels,
  currentUserId,
  canDelete,
  onClose,
  onSaved,
}: CardModalProps & { target: CardModalTarget }) {
  const { d, intl } = useI18n();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(target));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const isEdit = target.mode === "edit";
  const cardId = target.mode === "edit" ? target.card.id : null;

  const [comments, setComments] = React.useState<CommentWithAuthor[]>([]);
  const [commentDraft, setCommentDraft] = React.useState("");
  const [loadingComments, setLoadingComments] = React.useState(isEdit);
  const [postingComment, setPostingComment] = React.useState(false);

  // Comments only exist once the card has been saved
  React.useEffect(() => {
    if (!cardId) return;

    let active = true;
    const supabase = createClient();

    void supabase
      .from("card_comments")
      .select("*, author:profiles(*)")
      .eq("card_id", cardId)
      .order("created_at")
      .then(({ data }) => {
        if (!active) return;
        setComments((data ?? []) as CommentWithAuthor[]);
        setLoadingComments(false);
      });

    return () => {
      active = false;
    };
  }, [cardId]);

  function patch(changes: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
  }

  /** Reconciles card_assignees: deletes the removed, inserts the added. */
  async function syncAssignees(id: string, previousIds: string[]) {
    const supabase = createClient();
    const removed = previousIds.filter((userId) => !draft.assigneeIds.includes(userId));
    const added = draft.assigneeIds.filter((userId) => !previousIds.includes(userId));

    if (removed.length > 0) {
      await supabase.from("card_assignees").delete().eq("card_id", id).in("user_id", removed);
    }

    if (added.length > 0) {
      await supabase
        .from("card_assignees")
        .insert(added.map((userId) => ({ card_id: id, user_id: userId })));
    }
  }

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError(d.board.modal.titleRequired);
      return;
    }

    setSaving(true);
    setError(null);
    const supabase = createClient();

    const payload = {
      title,
      description: draft.description.trim() || null,
      priority: draft.priority,
      labels: draft.labels,
      due_date: draft.dueDate || null,
    };

    if (target.mode === "create") {
      // Place the new card at the end of the column
      const { count } = await supabase
        .from("cards")
        .select("id", { count: "exact", head: true })
        .eq("column_id", target.columnId);

      const { data, error: insertError } = await supabase
        .from("cards")
        .insert({
          ...payload,
          column_id: target.columnId,
          position: count ?? 0,
          created_by: currentUserId,
        })
        .select("id")
        .single();

      if (insertError || !data) {
        setError(insertError?.message ?? d.board.modal.createFailed);
        setSaving(false);
        return;
      }

      await syncAssignees(data.id, []);
    } else {
      const { error: updateError } = await supabase
        .from("cards")
        .update(payload)
        .eq("id", target.card.id);

      if (updateError) {
        setError(updateError.message);
        setSaving(false);
        return;
      }

      await syncAssignees(
        target.card.id,
        target.card.assignees.map((assignee) => assignee.id),
      );
    }

    await onSaved();
    onClose();
  }

  async function remove() {
    if (target.mode !== "edit") return;

    setDeleting(true);
    const supabase = createClient();
    const { error: deleteError } = await supabase.from("cards").delete().eq("id", target.card.id);

    if (deleteError) {
      setError(deleteError.message);
      setDeleting(false);
      return;
    }

    await onSaved();
    onClose();
  }

  async function postComment() {
    const content = commentDraft.trim();
    if (!content || !cardId) return;

    setPostingComment(true);
    const supabase = createClient();

    const { data, error: commentError } = await supabase
      .from("card_comments")
      .insert({ card_id: cardId, author_id: currentUserId, content })
      .select("*, author:profiles(*)")
      .single();

    if (!commentError && data) {
      setComments((previous) => [...previous, data as CommentWithAuthor]);
      setCommentDraft("");
    } else if (commentError) {
      setError(commentError.message);
    }

    setPostingComment(false);
  }

  return (
    <>
      <div className="space-y-1.5 pr-8">
        <DialogTitle asChild>
          <Input
            value={draft.title}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder={d.board.modal.titlePlaceholder}
            aria-label={d.board.modal.titleLabel}
            className="h-auto border-transparent bg-transparent px-0 text-[17px] font-semibold hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
          />
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? d.board.modal.editSubtitle
            : d.board.modal.createSubtitle}
        </DialogDescription>
      </div>

      {error && (
        <p className="rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b]">
          {error}
        </p>
      )}

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="card-description">{d.board.modal.description}</Label>
          <Textarea
            id="card-description"
            rows={4}
            value={draft.description}
            placeholder={d.board.modal.descriptionPlaceholder}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{d.board.priority.label}</Label>
            <Select
              value={draft.priority}
              onValueChange={(value) => patch({ priority: value as Priority })}
            >
              <SelectTrigger aria-label={d.board.priority.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 rounded-full", PRIORITY_DOT[priority])} />
                      {priorityLabel(d, priority)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-due">{d.board.modal.dueDate}</Label>
            <div className="relative">
              <Input
                id="card-due"
                type="date"
                value={draft.dueDate}
                onChange={(event) => patch({ dueDate: event.target.value })}
                className="pr-9"
              />
              <CalendarDays
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                aria-hidden
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>{d.board.modal.assignees}</Label>
          <AssigneeSelector
            members={members}
            selectedIds={draft.assigneeIds}
            onToggle={(userId) =>
              patch({
                assigneeIds: draft.assigneeIds.includes(userId)
                  ? draft.assigneeIds.filter((id) => id !== userId)
                  : [...draft.assigneeIds, userId],
              })
            }
          />
        </div>

        <div className="space-y-2">
          <Label>{d.board.modal.labels}</Label>
          <LabelSelector
            value={draft.labels}
            known={knownLabels}
            onChange={(labels) => patch({ labels })}
          />
        </div>
      </div>

      {isEdit && (
        <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5">
          <h3 className="label-caps">{d.board.modal.comments}</h3>

          {loadingComments ? (
            <p className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {d.common.loading}
            </p>
          ) : comments.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-muted)]">
              {d.board.modal.noComments}
            </p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-3 overflow-y-auto pr-1">
              {comments.map((comment) => (
                <li key={comment.id} className="flex gap-2.5">
                  <Avatar
                    name={comment.author?.full_name ?? "?"}
                    src={comment.author?.avatar_url}
                    seed={comment.author_id ?? comment.id}
                    size="sm"
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                        {comment.author?.full_name ?? d.board.modal.deletedUser}
                      </span>
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                        {new Date(comment.created_at).toLocaleDateString(intl, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                      {comment.content}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={commentDraft}
              placeholder={d.board.modal.commentPlaceholder}
              onChange={(event) => setCommentDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void postComment();
                }
              }}
              className="min-h-10"
            />
            <Button
              size="icon"
              variant="secondary"
              onClick={() => void postComment()}
              loading={postingComment}
              disabled={!commentDraft.trim()}
              aria-label={d.board.modal.sendComment}
            >
              {!postingComment && <Send />}
            </Button>
          </div>
        </section>
      )}

      <DialogFooter className="border-t border-[var(--border-subtle)] pt-5 sm:justify-between">
        {isEdit && canDelete ? (
          <Button variant="danger" onClick={() => void remove()} loading={deleting}>
            {!deleting && <Trash2 />}
            {d.common.delete}
          </Button>
        ) : (
          <span />
        )}

        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {d.common.cancel}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {isEdit ? d.board.modal.saveChanges : d.board.modal.create}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
