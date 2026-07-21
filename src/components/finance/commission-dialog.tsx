"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
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
import { COMMISSION_STATUSES, commissionStatusLabel } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money } from "@/lib/format-intl";
import { isoDay } from "@/lib/finance/queries";
import type { CrmClient, Commission, CommissionStatus, RevenueSource } from "@/lib/supabase/types";

export type CommissionTarget = { mode: "create" } | { mode: "edit"; commission: Commission };

const NO_CLIENT = "__none__";

type Draft = {
  sourceId: string;
  clientId: string;
  occurredOn: string;
  gross: string;
  rate: string;
  amount: string;
  status: CommissionStatus;
  notes: string;
};

function draftFrom(target: CommissionTarget, sources: RevenueSource[]): Draft {
  if (target.mode === "edit") {
    const c = target.commission;
    return {
      sourceId: c.source_id,
      clientId: c.client_id ?? NO_CLIENT,
      occurredOn: c.occurred_on,
      gross: String(c.gross_amount ?? ""),
      rate: String(c.rate ?? ""),
      amount: String(c.amount ?? ""),
      status: c.status,
      notes: c.notes ?? "",
    };
  }

  const first = sources.find((source) => source.active) ?? sources[0];
  return {
    sourceId: first?.id ?? "",
    clientId: NO_CLIENT,
    occurredOn: isoDay(new Date()),
    gross: "",
    rate: first ? String(first.default_rate) : "",
    amount: "",
    status: "confirmed",
    notes: "",
  };
}

export function CommissionDialog({
  target,
  sources,
  clients,
  currentUserId,
  onClose,
  onSaved,
}: {
  target: CommissionTarget | null;
  sources: RevenueSource[];
  clients: CrmClient[];
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const key =
    target === null ? "none" : target.mode === "edit" ? `edit:${target.commission.id}` : "create";

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {target && (
          <Body
            key={key}
            target={target}
            sources={sources}
            clients={clients}
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
  sources,
  clients,
  currentUserId,
  onClose,
  onSaved,
}: {
  target: CommissionTarget;
  sources: RevenueSource[];
  clients: CrmClient[];
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { d, intl } = useI18n();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(target, sources));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const isEdit = target.mode === "edit";
  const t = d.finance.revenue;

  function patch(changes: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
  }

  /**
   * Picking a source pulls in its default rate, but only while the amount is
   * still untouched — silently rewriting a number someone already typed would
   * be worse than a stale default.
   */
  function pickSource(sourceId: string) {
    const source = sources.find((item) => item.id === sourceId);
    if (source && !draft.amount) {
      patch({ sourceId, rate: String(source.default_rate) });
    } else {
      patch({ sourceId });
    }
  }

  const grossNumber = Number(draft.gross.replace(",", "."));
  const rateNumber = Number(draft.rate.replace(",", "."));
  const derived =
    Number.isFinite(grossNumber) && Number.isFinite(rateNumber) && grossNumber > 0 && rateNumber > 0
      ? (grossNumber * rateNumber) / 100
      : null;

  async function save() {
    const amount = Number(draft.amount.replace(",", "."));

    if (!draft.sourceId) {
      setError(t.sourceRequired);
      return;
    }
    if (!draft.amount.trim() || !Number.isFinite(amount)) {
      setError(t.amountRequired);
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      source_id: draft.sourceId,
      client_id: draft.clientId === NO_CLIENT ? null : draft.clientId,
      occurred_on: draft.occurredOn,
      gross_amount: Number.isFinite(grossNumber) ? grossNumber : 0,
      rate: Number.isFinite(rateNumber) ? rateNumber : 0,
      amount,
      status: draft.status,
      notes: draft.notes.trim() || null,
    };

    const supabase = createClient();
    const { error: saveError } =
      target.mode === "create"
        ? await supabase.from("commissions").insert({ ...payload, created_by: currentUserId })
        : await supabase.from("commissions").update(payload).eq("id", target.commission.id);

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
      .from("commissions")
      .delete()
      .eq("id", target.commission.id);

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
            <Label>{t.source}</Label>
            <Select value={draft.sourceId} onValueChange={pickSource}>
              <SelectTrigger aria-label={t.source}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                    {!source.active && ` · ${t.inactive}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t.client}</Label>
            <Select value={draft.clientId} onValueChange={(value) => patch({ clientId: value })}>
              <SelectTrigger aria-label={t.client}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CLIENT}>{t.noClient}</SelectItem>
                {clients.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="c-gross">{t.grossAmount}</Label>
            <Input
              id="c-gross"
              inputMode="decimal"
              placeholder="0.00"
              value={draft.gross}
              onChange={(event) => patch({ gross: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="c-rate">{t.rate}</Label>
            <Input
              id="c-rate"
              inputMode="decimal"
              placeholder="0"
              value={draft.rate}
              onChange={(event) => patch({ rate: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="c-amount">{t.amount}</Label>
            <Input
              id="c-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={draft.amount}
              onChange={(event) => patch({ amount: event.target.value })}
            />
          </div>
        </div>

        {derived !== null && (
          <button
            type="button"
            onClick={() => patch({ amount: derived.toFixed(2) })}
            className="w-full rounded-[10px] border border-dashed border-[var(--border-strong)] px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] transition-smooth hover:border-[var(--accent-gold)]/40 hover:text-[var(--text-primary)]"
          >
            {t.autoCalc}: <span className="text-[var(--accent-gold)]">{money(derived, intl)}</span>
          </button>
        )}
        <p className="text-[11.5px] text-[var(--text-muted)]">{t.grossHelp}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="c-date">{t.date}</Label>
            <Input
              id="c-date"
              type="date"
              value={draft.occurredOn}
              onChange={(event) => patch({ occurredOn: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t.status}</Label>
            <Select
              value={draft.status}
              onValueChange={(value) => patch({ status: value as CommissionStatus })}
            >
              <SelectTrigger aria-label={t.status}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMISSION_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {commissionStatusLabel(d, status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="c-notes">{t.notes}</Label>
          <Textarea
            id="c-notes"
            rows={2}
            placeholder={t.notesPlaceholder}
            value={draft.notes}
            onChange={(event) => patch({ notes: event.target.value })}
          />
          <FieldError />
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
