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
import { EXPENSE_CATEGORIES, expenseCategoryLabel } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { isoDay } from "@/lib/finance/queries";
import type { Expense, ExpenseCategory } from "@/lib/supabase/types";

export type ExpenseTarget = { mode: "create" } | { mode: "edit"; expense: Expense };

type Draft = {
  category: ExpenseCategory;
  vendor: string;
  description: string;
  incurredOn: string;
  amount: string;
  recurring: boolean;
};

function draftFrom(target: ExpenseTarget): Draft {
  if (target.mode === "edit") {
    const e = target.expense;
    return {
      category: e.category,
      vendor: e.vendor ?? "",
      description: e.description ?? "",
      incurredOn: e.incurred_on,
      amount: String(e.amount ?? ""),
      recurring: e.recurring,
    };
  }

  return {
    category: "tools",
    vendor: "",
    description: "",
    incurredOn: isoDay(new Date()),
    amount: "",
    recurring: false,
  };
}

export function ExpenseDialog({
  target,
  currentUserId,
  onClose,
  onSaved,
}: {
  target: ExpenseTarget | null;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const key =
    target === null ? "none" : target.mode === "edit" ? `edit:${target.expense.id}` : "create";

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {target && (
          <Body
            key={key}
            target={target}
            currentUserId={currentUserId}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  target,
  currentUserId,
  onClose,
  onSaved,
}: {
  target: ExpenseTarget;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { d } = useI18n();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(target));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const isEdit = target.mode === "edit";
  const t = d.finance.expenses;

  function patch(changes: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
  }

  async function save() {
    const amount = Number(draft.amount.replace(",", "."));

    if (!draft.amount.trim() || !Number.isFinite(amount)) {
      setError(t.amountRequired);
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      category: draft.category,
      vendor: draft.vendor.trim() || null,
      description: draft.description.trim() || null,
      incurred_on: draft.incurredOn,
      amount,
      recurring: draft.recurring,
    };

    const supabase = createClient();
    const { error: saveError } =
      target.mode === "create"
        ? await supabase.from("expenses").insert({ ...payload, created_by: currentUserId })
        : await supabase.from("expenses").update(payload).eq("id", target.expense.id);

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
      .from("expenses")
      .delete()
      .eq("id", target.expense.id);

    if (deleteError) {
      setError(fmt(d.finance.deleteFailed, { message: deleteError.message }));
      setDeleting(false);
      return;
    }

    await onSaved();
    onClose();
  }

  return (
    <>
      <div className="space-y-1.5 pr-8">
        <DialogTitle>{isEdit ? t.editEntry : t.newEntry}</DialogTitle>
        <DialogDescription>{isEdit ? t.editSubtitle : t.createSubtitle}</DialogDescription>
      </div>

      {error && (
        <p className="rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b]">
          {error}
        </p>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t.category}</Label>
            <Select
              value={draft.category}
              onValueChange={(value) => patch({ category: value as ExpenseCategory })}
            >
              <SelectTrigger aria-label={t.category}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {expenseCategoryLabel(d, category)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="e-amount">{t.amount}</Label>
            <Input
              id="e-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={draft.amount}
              onChange={(event) => patch({ amount: event.target.value })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="e-vendor">{t.vendor}</Label>
            <Input
              id="e-vendor"
              placeholder={t.vendorPlaceholder}
              value={draft.vendor}
              onChange={(event) => patch({ vendor: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="e-date">{t.date}</Label>
            <Input
              id="e-date"
              type="date"
              value={draft.incurredOn}
              onChange={(event) => patch({ incurredOn: event.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="e-description">{t.description}</Label>
          <Textarea
            id="e-description"
            rows={2}
            placeholder={t.descriptionPlaceholder}
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </div>

        <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]">
          <Checkbox
            checked={draft.recurring}
            onCheckedChange={(checked) => patch({ recurring: checked === true })}
          />
          {t.recurring}
        </label>
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
