"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { SOURCE_CATEGORIES, sourceCategoryLabel } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import type { RevenueSource, SourceCategory } from "@/lib/supabase/types";

export type SourceTarget = { mode: "create" } | { mode: "edit"; source: RevenueSource };

type Draft = {
  name: string;
  category: SourceCategory;
  rate: string;
  recurring: boolean;
  active: boolean;
  notes: string;
};

function draftFrom(target: SourceTarget): Draft {
  if (target.mode === "edit") {
    const s = target.source;
    return {
      name: s.name,
      category: s.category,
      rate: String(s.default_rate ?? ""),
      recurring: s.recurring,
      active: s.active,
      notes: s.notes ?? "",
    };
  }

  return {
    name: "",
    category: "platform",
    rate: "",
    recurring: true,
    active: true,
    notes: "",
  };
}

export function SourceDialog({
  target,
  onClose,
  onSaved,
}: {
  target: SourceTarget | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const key =
    target === null ? "none" : target.mode === "edit" ? `edit:${target.source.id}` : "create";

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {target && <Body key={key} target={target} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  target,
  onClose,
  onSaved,
}: {
  target: SourceTarget;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { d } = useI18n();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(target));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const isEdit = target.mode === "edit";
  const t = d.finance.revenue;

  function patch(changes: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      setError(t.sourceName);
      return;
    }

    setSaving(true);
    setError(null);

    const rate = Number(draft.rate.replace(",", "."));
    const payload = {
      name,
      category: draft.category,
      default_rate: Number.isFinite(rate) ? rate : 0,
      recurring: draft.recurring,
      active: draft.active,
      notes: draft.notes.trim() || null,
    };

    const supabase = createClient();
    const { error: saveError } =
      target.mode === "create"
        ? await supabase.from("revenue_sources").insert(payload)
        : await supabase.from("revenue_sources").update(payload).eq("id", target.source.id);

    if (saveError) {
      setError(fmt(d.finance.saveFailed, { message: saveError.message }));
      setSaving(false);
      return;
    }

    await onSaved();
    onClose();
  }

  async function remove() {
    if (target.mode !== "edit") return;
    if (!window.confirm(d.finance.deleteConfirm)) return;

    setDeleting(true);
    const supabase = createClient();
    const { error: deleteError } = await supabase
      .from("revenue_sources")
      .delete()
      .eq("id", target.source.id);

    if (deleteError) {
      // on delete restrict: the source still has commissions pointing at it.
      // Deleting would rewrite history, so steer towards deactivating instead.
      const inUse = deleteError.code === "23503";
      setError(inUse ? t.sourceInUse : fmt(d.finance.deleteFailed, { message: deleteError.message }));
      setDeleting(false);
      return;
    }

    await onSaved();
    onClose();
  }

  return (
    <>
      <div className="space-y-1.5 pr-8">
        <DialogTitle>{isEdit ? t.editSource : t.newSource}</DialogTitle>
        <DialogDescription>{t.sources}</DialogDescription>
      </div>

      {error && (
        <p className="rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b]">
          {error}
        </p>
      )}

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="s-name">{t.sourceName}</Label>
          <Input
            id="s-name"
            placeholder={t.sourceNamePlaceholder}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t.sourceCategoryLabel}</Label>
            <Select
              value={draft.category}
              onValueChange={(value) => patch({ category: value as SourceCategory })}
            >
              <SelectTrigger aria-label={t.sourceCategoryLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {sourceCategoryLabel(d, category)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="s-rate">{t.defaultRate}</Label>
            <Input
              id="s-rate"
              inputMode="decimal"
              placeholder="0"
              value={draft.rate}
              onChange={(event) => patch({ rate: event.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="s-notes">{d.finance.revenue.notes}</Label>
          <Textarea
            id="s-notes"
            rows={2}
            value={draft.notes}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2.5">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]">
            <Checkbox
              checked={draft.recurring}
              onCheckedChange={(checked) => patch({ recurring: checked === true })}
            />
            {t.recurring}
            <span className="text-[11.5px] text-[var(--text-muted)]">— {t.recurringHelp}</span>
          </label>

          <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]">
            <Checkbox
              checked={draft.active}
              onCheckedChange={(checked) => patch({ active: checked === true })}
            />
            {t.active}
          </label>
        </div>
      </div>

      <DialogFooter className="border-t border-[var(--border-subtle)] pt-5 sm:justify-between">
        {isEdit ? (
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
            {d.common.save}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
