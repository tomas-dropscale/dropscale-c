"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  ChevronRight,
  Loader2,
  Pause,
  Pencil,
  Play,
  Search,
  Store,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_CAMPAIGN_DAILY_BUDGET,
  MIN_CAMPAIGN_DAILY_BUDGET,
  dailyBudgetDraft,
  dailyBudgetWithinLimit,
  filterCampaignClients,
  normalizeDailyBudgetInput,
  projectCampaignClients,
  type CampaignActionHistory,
  type CampaignViewCampaign,
  type CampaignViewClient,
  type ProjectedCampaign,
  type ProjectedCampaignClient,
} from "@/lib/admin/campaigns-view";
import { money, multiplier } from "@/lib/format";
import { cn } from "@/lib/utils";

const CAMPAIGN_GRID =
  "xl:grid-cols-[minmax(190px,1.65fr)_repeat(7,minmax(88px,1fr))]";

const SCALE_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Lisbon",
});

const SCALE_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Lisbon",
});

type ActionResult = { ok: true } | { ok: false; error: string };

type BudgetActionBody = {
  requestId: string;
  bindingId: string;
  providerCampaignId: string;
  action: "set_daily_budget";
  expectedDailyBudget: string;
  nextDailyBudget: string;
};

type StatusActionBody = {
  requestId: string;
  bindingId: string;
  providerCampaignId: string;
  action: "pause" | "enable";
  expectedStatus: "active" | "paused";
};

const campaignKey = (campaign: CampaignViewCampaign) =>
  `${campaign.adAccountId}:${campaign.providerCampaignId}`;

function safeDate(formatter: Intl.DateTimeFormat, value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "—" : formatter.format(timestamp);
}

function campaignTypeLabel(
  campaign: Pick<CampaignViewCampaign, "type" | "shoppingFeed">,
) {
  if (campaign.type === "DEMAND_GEN") return "DGEN";
  if (campaign.type === "PERFORMANCE_MAX") {
    return campaign.shoppingFeed ? "PMAX (SF)" : "PMAX";
  }
  return campaign.type.replaceAll("_", " ");
}

function responseError(status: number) {
  if (status === 401) return "Your session expired. Sign in again before changing this campaign.";
  if (status === 403) return "This account is not authorised for campaign actions.";
  if (status === 409) return "The campaign changed. Refresh the page before trying again.";
  if (status === 429) return "Too many campaign actions. Wait a moment and try again.";
  return "The campaign action could not be confirmed. Refresh before trying again.";
}

function floatingPosition(anchor: DOMRect, preferredWidth: number) {
  const padding = 16;
  const gap = 8;
  const width = Math.min(preferredWidth, window.innerWidth - padding * 2);
  const left = Math.max(
    padding,
    Math.min(window.innerWidth - width - padding, anchor.left + anchor.width / 2 - width / 2),
  );
  const spaceAbove = anchor.top - padding - gap;
  const spaceBelow = window.innerHeight - anchor.bottom - padding - gap;
  const above = spaceAbove >= spaceBelow && spaceAbove >= 96;
  return {
    above,
    style: {
      left,
      top: above ? anchor.top - gap : anchor.bottom + gap,
      width,
      maxHeight: Math.max(96, above ? spaceAbove : spaceBelow),
    } satisfies React.CSSProperties,
  };
}

function ClientMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="min-w-0">
      <span className="label-caps mb-0.5 block md:hidden">{label}</span>
      <span className="block truncate text-[13px] font-medium tabular-nums text-[var(--text-primary)]">
        {children}
      </span>
    </span>
  );
}

function CampaignMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="min-w-0 xl:text-center">
      <span className="label-caps mb-0.5 block xl:hidden">{label}</span>
      <span className="block truncate text-[13px] font-medium tabular-nums text-[var(--text-primary)]">
        {children}
      </span>
    </span>
  );
}

function BudgetControl({
  campaign,
  busy,
  onChange,
}: {
  campaign: ProjectedCampaign;
  busy: boolean;
  onChange: (nextDailyBudget: string) => Promise<ActionResult>;
}) {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const popup = React.useRef<HTMLFormElement>(null);
  const historyPanel = React.useRef<HTMLDivElement>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFocus = React.useRef(false);
  const historyId = React.useId();
  const inputId = React.useId();
  const errorId = `${inputId}-error`;
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyKeyboardOpen, setHistoryKeyboardOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(() => dailyBudgetDraft(campaign.dailyBudget));
  const [error, setError] = React.useState("");
  const canEdit =
    campaign.actionable &&
    campaign.status !== "ended" &&
    campaign.dailyBudget !== null;

  function updateAnchor() {
    if (trigger.current) setAnchor(trigger.current.getBoundingClientRect());
  }

  function clearCloseTimer() {
    if (!closeTimer.current) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function showHistory() {
    if (editing) return;
    clearCloseTimer();
    updateAnchor();
    setHistoryOpen(true);
  }

  function scheduleHistoryClose() {
    if (historyKeyboardOpen) return;
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setHistoryOpen(false), 100);
  }

  function openHistoryWithKeyboard() {
    if (editing) return;
    clearCloseTimer();
    updateAnchor();
    setHistoryOpen(true);
    setHistoryKeyboardOpen(true);
  }

  function closeKeyboardHistory() {
    setHistoryKeyboardOpen(false);
    setHistoryOpen(false);
    trigger.current?.focus();
  }

  const closeEditor = React.useCallback(() => {
    setEditing(false);
    setError("");
    setDraft(dailyBudgetDraft(campaign.dailyBudget));
    restoreFocus.current = true;
  }, [campaign.dailyBudget]);

  function openEditor() {
    if (!canEdit || busy) return;
    clearCloseTimer();
    setHistoryOpen(false);
    setDraft(dailyBudgetDraft(campaign.dailyBudget));
    setError("");
    updateAnchor();
    setEditing(true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const nextDailyBudget = normalizeDailyBudgetInput(draft);
    if (!nextDailyBudget) {
      setError("Enter a budget above 0 with no more than 6 decimal places.");
      return;
    }
    if (nextDailyBudget === dailyBudgetDraft(campaign.dailyBudget)) {
      setError("Choose a different daily budget.");
      return;
    }
    if (!dailyBudgetWithinLimit(nextDailyBudget)) {
      setError(
        `Daily budgets must be between ${money(MIN_CAMPAIGN_DAILY_BUDGET, campaign.currency)} and ${money(MAX_CAMPAIGN_DAILY_BUDGET, campaign.currency)} per day.`,
      );
      return;
    }

    const result = await onChange(nextDailyBudget);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    closeEditor();
  }

  React.useEffect(() => {
    return () => clearCloseTimer();
  }, []);

  React.useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);

  React.useEffect(() => {
    if (historyKeyboardOpen && historyOpen && !editing) historyPanel.current?.focus();
  }, [editing, historyKeyboardOpen, historyOpen]);

  React.useEffect(() => {
    if (!editing && !historyOpen) return;
    const reposition = () => updateAnchor();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [editing, historyOpen]);

  React.useEffect(() => {
    if (!editing) return;

    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) closeEditor();
    }

    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") closeEditor();
    }

    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [editing, closeEditor]);

  const tooltipPosition = anchor && historyOpen ? floatingPosition(anchor, 300) : null;
  const editorPosition = anchor && editing ? floatingPosition(anchor, 280) : null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 xl:grid xl:grid-cols-[1.75rem_minmax(0,auto)_1.75rem] xl:justify-center">
      <span className="hidden size-7 xl:block" aria-hidden />
      <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">
        {campaign.dailyBudget === null ? "—" : money(campaign.dailyBudget, campaign.currency)}
        {campaign.dailyBudget !== null && (
          <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">/ day</span>
        )}
      </span>

      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-10 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 xl:size-7"
        aria-label={
          canEdit
            ? `Edit daily budget for ${campaign.name}; hover or focus for scale history`
            : `View scale history for ${campaign.name}`
        }
        aria-describedby={historyOpen ? historyId : undefined}
        aria-expanded={editing}
        aria-haspopup={canEdit ? "dialog" : undefined}
        aria-disabled={!canEdit || busy}
        onClick={openEditor}
        onMouseEnter={showHistory}
        onMouseLeave={scheduleHistoryClose}
        onFocus={showHistory}
        onBlur={scheduleHistoryClose}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openHistoryWithKeyboard();
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Pencil aria-hidden />}
      </Button>

      {tooltipPosition &&
        !editing &&
        createPortal(
          <div
            ref={historyPanel}
            id={historyId}
            role="region"
            aria-label={`Scale history for ${campaign.name}`}
            tabIndex={0}
            style={tooltipPosition.style}
            className={cn(
              "fixed z-[110] max-h-[min(320px,calc(100vh-32px))] overflow-y-auto rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-left shadow-2xl shadow-black/45",
              tooltipPosition.above && "-translate-y-full",
            )}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleHistoryClose}
            onFocus={clearCloseTimer}
            onBlur={() => {
              setHistoryKeyboardOpen(false);
              clearCloseTimer();
              closeTimer.current = setTimeout(() => setHistoryOpen(false), 100);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeKeyboardHistory();
              }
            }}
          >
            <p className="text-[12px] font-semibold text-[var(--text-primary)]">Scale history</p>
            {campaign.scaleHistory.length > 0 ? (
              <ol className="mt-2 space-y-2">
                {campaign.scaleHistory.map((scale) => (
                  <li
                    key={scale.id}
                    className="border-t border-[var(--border-subtle)] pt-2 first:border-t-0 first:pt-0"
                  >
                    <time
                      dateTime={scale.occurredAt}
                      className="block text-[10.5px] tabular-nums text-[var(--text-muted)]"
                    >
                      {safeDate(SCALE_DATE_TIME, scale.occurredAt)} · {scale.actorName}
                    </time>
                    <p className="mt-0.5 text-[11.5px] font-medium tabular-nums text-[var(--text-primary)]">
                      {money(scale.previousDailyBudget, scale.currency)} →{" "}
                      {money(scale.nextDailyBudget, scale.currency)} / day
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                No verified budget scales recorded yet.
              </p>
            )}
          </div>,
          document.body,
        )}

      {editorPosition &&
        createPortal(
          <form
            ref={popup}
            role="dialog"
            aria-label={`Edit daily budget for ${campaign.name}`}
            style={editorPosition.style}
            className={cn(
              "fixed z-[120] rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-left shadow-2xl shadow-black/50",
              editorPosition.above && "-translate-y-full",
            )}
            onSubmit={submit}
          >
            <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              Edit daily budget
            </p>
            <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">
              {campaign.name}
            </p>
            <label className="label-caps mt-3 block" htmlFor={inputId}>
              Budget per day
            </label>
            <div className="relative mt-1.5">
              <Input
                id={inputId}
                autoFocus
                type="text"
                inputMode="decimal"
                maxLength={15}
                value={draft}
                disabled={busy}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                className="h-10 pr-14 tabular-nums"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError("");
                }}
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] font-medium text-[var(--text-muted)]">
                {campaign.currency}
              </span>
            </div>
            {error && (
              <p id={errorId} role="alert" className="mt-1.5 text-[11px] text-[var(--danger-red)]">
                {error}
              </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={closeEditor}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                Save budget
              </Button>
            </div>
          </form>,
          document.body,
        )}
    </div>
  );
}

function CampaignRow({
  campaign,
  busy,
  statusError,
  onBudgetChange,
  onStatusChange,
}: {
  campaign: ProjectedCampaign;
  busy: boolean;
  statusError: string | undefined;
  onBudgetChange: (campaign: ProjectedCampaign, nextDailyBudget: string) => Promise<ActionResult>;
  onStatusChange: (campaign: ProjectedCampaign) => void;
}) {
  const nextAction = campaign.status === "active" ? "Pause" : "Enable";
  const canChangeStatus = campaign.actionable && campaign.status !== "ended";

  return (
    <li
      className={cn(
        "grid grid-cols-2 items-center gap-x-3 gap-y-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 lg:px-5",
        CAMPAIGN_GRID,
      )}
    >
      <div className="col-span-2 min-w-0 xl:col-span-1 xl:pl-6">
        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
          {campaign.name}
        </p>
      </div>

      <div className="min-w-0 xl:text-center">
        <span className="label-caps mb-1 block xl:hidden">Type</span>
        <Badge variant="neutral">{campaignTypeLabel(campaign)}</Badge>
      </div>

      <div className="min-w-0 xl:text-center">
        <span className="label-caps mb-1 block xl:hidden">Status</span>
        <Badge variant={campaign.status === "active" ? "success" : "neutral"}>
          {campaign.status === "active"
            ? "Active"
            : campaign.status === "paused"
              ? "Paused"
              : "Ended"}
        </Badge>
      </div>

      <CampaignMetric label="Spend">{money(campaign.spend, campaign.currency)}</CampaignMetric>

      <div className="col-span-2 min-w-0 sm:col-span-1 xl:col-span-1">
        <span className="label-caps mb-1 block xl:hidden">Daily budget</span>
        <BudgetControl
          campaign={campaign}
          busy={busy}
          onChange={(nextDailyBudget) => onBudgetChange(campaign, nextDailyBudget)}
        />
      </div>

      <CampaignMetric label="ROAS">
        {campaign.googleRoas === null ? "—" : multiplier(campaign.googleRoas)}
      </CampaignMetric>

      <CampaignMetric label="Last scaled at">
        {campaign.lastScaledAt ? safeDate(SCALE_DATE, campaign.lastScaledAt) : "—"}
      </CampaignMetric>

      <div className="flex justify-self-end xl:justify-self-center">
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="size-10 xl:size-8"
          disabled={!canChangeStatus || busy}
          aria-label={`${nextAction} ${campaign.name}`}
          title={canChangeStatus ? `${nextAction} ${campaign.name}` : "Campaign action unavailable"}
          onClick={() => onStatusChange(campaign)}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : campaign.status === "active" ? (
            <Pause aria-hidden />
          ) : (
            <Play aria-hidden />
          )}
        </Button>
      </div>

      {statusError && (
        <p
          role="alert"
          className="col-span-2 text-[11px] text-[var(--danger-red)] xl:col-span-8 xl:pl-6"
        >
          {statusError}
        </p>
      )}
    </li>
  );
}

function StoreGroup({
  clientId,
  store,
  pending,
  statusErrors,
  onBudgetChange,
  onStatusChange,
}: {
  clientId: string;
  store: ProjectedCampaignClient["stores"][number];
  pending: Set<string>;
  statusErrors: Record<string, string>;
  onBudgetChange: (campaign: ProjectedCampaign, nextDailyBudget: string) => Promise<ActionResult>;
  onStatusChange: (campaign: ProjectedCampaign) => void;
}) {
  const headingId = React.useId();
  const spend = store.rollupSpend;
  const budgets = store.campaigns.map((campaign) =>
    campaign.dailyBudget === null ? null : Number(campaign.dailyBudget),
  );
  const dailyBudget =
    store.campaignState === "ready" &&
    budgets.length > 0 &&
    budgets.every((budget): budget is number => budget !== null)
    ? budgets.reduce((sum, budget) => sum + budget, 0)
    : null;
  const storeLabel = store.domain ? `https://${store.domain}` : store.name;

  return (
    <section aria-labelledby={headingId} className="border-t border-[var(--border-strong)] first:border-t-0">
      <header
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 bg-[var(--bg-base)] px-4 py-4 lg:px-5",
          CAMPAIGN_GRID,
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5 xl:col-span-7 xl:pl-6">
          <Store className="size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
          <h3
            id={headingId}
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]"
          >
            {storeLabel}
          </h3>
        </div>

        <Button
          asChild
          variant="secondary"
          size="icon"
          className="size-10 shrink-0 justify-self-center xl:size-8"
        >
          <Link
            href={`/admin/analytics?client=${encodeURIComponent(clientId)}&store=${encodeURIComponent(store.id)}`}
            aria-label={`Open store analytics for ${store.name}`}
            title={`Open store analytics for ${store.name}`}
          >
            <BarChart3 aria-hidden />
          </Link>
        </Button>
      </header>

      <div
        className={cn(
          "hidden gap-x-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-5 py-2.5 xl:grid",
          CAMPAIGN_GRID,
        )}
      >
        <span className="label-caps pl-6">Campaign</span>
        <span className="label-caps text-center">Type</span>
        <span className="label-caps text-center">Status</span>
        <span className="label-caps text-center">Spend</span>
        <span className="label-caps text-center">Daily budget</span>
        <span
          className="label-caps text-center"
          title="Google-attributed ROAS per campaign; Real ROAS on the store total"
        >
          ROAS
        </span>
        <span className="label-caps text-center">Last Scaled at</span>
        <span className="label-caps text-center">Action</span>
      </div>
      <ul>
        <li
          className={cn(
            "grid grid-cols-2 items-center gap-x-3 gap-y-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 lg:px-5",
            CAMPAIGN_GRID,
          )}
        >
          <span className="col-span-2 text-[12px] font-semibold tracking-[0.08em] text-[var(--text-primary)] xl:col-span-1 xl:pl-6">
            TOTAL
          </span>
          <CampaignMetric label="Type">—</CampaignMetric>
          <CampaignMetric label="Status">—</CampaignMetric>
          <CampaignMetric label="Spend">{money(spend, store.currency)}</CampaignMetric>
          <CampaignMetric label="Daily budget">
            {dailyBudget === null ? "—" : money(dailyBudget, store.currency)}
            {dailyBudget !== null && (
              <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">
                / day
              </span>
            )}
          </CampaignMetric>
          <CampaignMetric label="Real ROAS">
            {store.realRoas === null ? "—" : multiplier(store.realRoas)}
          </CampaignMetric>
          <CampaignMetric label="Last scaled at">—</CampaignMetric>
          <span className="hidden xl:block" aria-hidden />
        </li>

        {store.campaignState !== "ready" && (
          <li className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-5 py-4 text-[12.5px] text-[var(--text-muted)]">
            {store.campaignState === "empty" &&
              "No campaign rows were returned for this period."}
            {store.campaignState === "partial" &&
              "Some Google Ads sources could not be loaded; the rows below are partial."}
            {store.campaignState === "failed" &&
              "Campaign reporting failed for this store. Its verified rollup total is still shown above."}
            {store.campaignState === "disconnected" &&
              "Campaign reporting is unavailable until this Google Ads connection is restored."}
          </li>
        )}

        {store.campaigns.map((campaign) => {
          const key = campaignKey(campaign);
          return (
            <CampaignRow
              key={key}
              campaign={campaign}
              busy={pending.has(key)}
              statusError={statusErrors[key]}
              onBudgetChange={onBudgetChange}
              onStatusChange={onStatusChange}
            />
          );
        })}
      </ul>
    </section>
  );
}

function ClientSection({
  client,
  open,
  pending,
  statusErrors,
  onToggle,
  onBudgetChange,
  onStatusChange,
}: {
  client: ProjectedCampaignClient;
  open: boolean;
  pending: Set<string>;
  statusErrors: Record<string, string>;
  onToggle: () => void;
  onBudgetChange: (campaign: ProjectedCampaign, nextDailyBudget: string) => Promise<ActionResult>;
  onStatusChange: (campaign: ProjectedCampaign) => void;
}) {
  const regionId = React.useId();

  return (
    <div className="border-t border-[var(--border-subtle)] first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={onToggle}
        className="transition-smooth grid min-h-12 w-full grid-cols-3 items-center gap-x-4 gap-y-3 px-4 py-4 text-left outline-none hover:bg-[var(--bg-panel-hover)] focus-visible:bg-[var(--bg-panel-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/30 md:grid-cols-[minmax(260px,1.6fr)_repeat(3,minmax(100px,.65fr))] md:px-5"
      >
        <span className="col-span-3 flex min-w-0 items-center gap-3 md:col-span-1">
          <ChevronRight
            className={cn(
              "transition-smooth size-4 shrink-0 text-[var(--text-muted)]",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[11px] font-semibold text-[var(--accent-gold-strong)]">
            {client.name
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
              {client.name}
            </span>
            <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-muted)]">
              {client.stores.length} {client.stores.length === 1 ? "store" : "stores"} · {client.email}
            </span>
          </span>
        </span>

        <ClientMetric label="Revenue">
          {client.revenue === null ? "—" : money(client.revenue, client.currency)}
        </ClientMetric>
        <ClientMetric label="Ad spend">{money(client.adSpend, client.currency)}</ClientMetric>
        <ClientMetric label="Real ROAS">
          {client.realRoas === null ? "—" : multiplier(client.realRoas)}
        </ClientMetric>
      </button>

      {open && (
        <div
          id={regionId}
          role="region"
          aria-label={`${client.name} stores and campaigns`}
          className="border-t border-[var(--border-subtle)]"
        >
          {client.stores.map((store) => (
            <StoreGroup
              key={store.id}
              clientId={client.id}
              store={store}
              pending={pending}
              statusErrors={statusErrors}
              onBudgetChange={onBudgetChange}
              onStatusChange={onStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CampaignsView({
  clients,
  history,
  historyTruncated,
}: {
  clients: CampaignViewClient[];
  history: CampaignActionHistory[];
  historyTruncated: boolean;
}) {
  const router = useRouter();
  const inFlight = React.useRef(new Set<string>());
  const requestIds = React.useRef(new Map<string, string>());
  const [query, setQuery] = React.useState("");
  const [openClients, setOpenClients] = React.useState(
    () => new Set(clients.slice(0, 1).map((client) => client.id)),
  );
  const [pending, setPending] = React.useState(() => new Set<string>());
  const [statusErrors, setStatusErrors] = React.useState<Record<string, string>>({});
  const projected = React.useMemo(() => projectCampaignClients(clients, history), [clients, history]);
  const visibleClients = React.useMemo(
    () => filterCampaignClients(projected, query),
    [projected, query],
  );

  function toggleClient(clientId: string) {
    setOpenClients((current) => {
      const next = new Set(current);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function setCampaignPending(key: string, value: boolean) {
    if (value) inFlight.current.add(key);
    else inFlight.current.delete(key);
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function sendAction(
    campaign: ProjectedCampaign,
    fingerprint: string,
    body: (requestId: string) => BudgetActionBody | StatusActionBody,
  ): Promise<ActionResult> {
    const key = campaignKey(campaign);
    if (inFlight.current.has(key)) return { ok: false, error: "This campaign action is pending." };

    const requestId = requestIds.current.get(fingerprint) ?? crypto.randomUUID();
    requestIds.current.set(fingerprint, requestId);
    setCampaignPending(key, true);

    try {
      const response = await fetch("/api/admin/campaign-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(requestId)),
      });
      if (!response.ok) return { ok: false, error: responseError(response.status) };

      requestIds.current.delete(fingerprint);
      router.refresh();
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: "The connection ended before the result was known. Refresh before trying again.",
      };
    } finally {
      setCampaignPending(key, false);
    }
  }

  function changeBudget(campaign: ProjectedCampaign, nextDailyBudget: string) {
    if (campaign.dailyBudget === null) {
      return Promise.resolve<ActionResult>({ ok: false, error: "This campaign has no daily budget." });
    }
    const fingerprint = [
      campaign.bindingId,
      campaign.providerCampaignId,
      "set_daily_budget",
      campaign.dailyBudget,
      nextDailyBudget,
    ].join(":");
    return sendAction(campaign, fingerprint, (requestId) => ({
      requestId,
      bindingId: campaign.bindingId,
      providerCampaignId: campaign.providerCampaignId,
      action: "set_daily_budget",
      expectedDailyBudget: campaign.dailyBudget!,
      nextDailyBudget,
    }));
  }

  async function changeStatus(campaign: ProjectedCampaign) {
    if (campaign.status === "ended") return;
    const key = campaignKey(campaign);
    setStatusErrors((current) => ({ ...current, [key]: "" }));
    const action = campaign.status === "active" ? "pause" : "enable";
    const expectedStatus = campaign.status === "active" ? "active" : "paused";
    const fingerprint = [
      campaign.bindingId,
      campaign.providerCampaignId,
      action,
      campaign.status,
    ].join(":");
    const result = await sendAction(campaign, fingerprint, (requestId) => ({
      requestId,
      bindingId: campaign.bindingId,
      providerCampaignId: campaign.providerCampaignId,
      action,
      expectedStatus,
    }));
    if (!result.ok) setStatusErrors((current) => ({ ...current, [key]: result.error }));
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="campaign-client-performance">
      <header className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-4 py-4 md:flex-row md:items-end md:justify-between md:px-5">
        <div className="min-w-0">
          <h2
            id="campaign-client-performance"
            className="text-[15px] font-semibold text-[var(--text-primary)]"
          >
            Client performance
          </h2>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Open a client to review every store and its Google campaigns.
          </p>
          {historyTruncated && (
            <p className="mt-1 text-[11px] text-[var(--accent-gold-strong)]">
              Scale history is limited to the 1,000 most recent verified changes.
            </p>
          )}
        </div>

        <form role="search" className="w-full md:w-[320px]" onSubmit={(event) => event.preventDefault()}>
          <label className="sr-only" htmlFor="campaign-client-search">
            Search clients or stores
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
              aria-hidden
            />
            <Input
              id="campaign-client-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search clients or stores"
              className="pr-9 pl-9"
            />
            {query && (
              <button
                type="button"
                className="focus-ring absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                onClick={() => setQuery("")}
                aria-label="Clear client search"
                title="Clear search"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </form>
      </header>

      <div className="hidden grid-cols-[minmax(260px,1.6fr)_repeat(3,minmax(100px,.65fr))] gap-4 border-b border-[var(--border-subtle)] px-5 py-2.5 md:grid">
        <span className="label-caps">Client</span>
        <span className="label-caps">Revenue</span>
        <span className="label-caps">Ad spend</span>
        <span className="label-caps">Real ROAS</span>
      </div>

      {visibleClients.length > 0 ? (
        visibleClients.map((client) => (
          <ClientSection
            key={client.id}
            client={client}
            open={openClients.has(client.id)}
            pending={pending}
            statusErrors={statusErrors}
            onToggle={() => toggleClient(client.id)}
            onBudgetChange={changeBudget}
            onStatusChange={changeStatus}
          />
        ))
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <p className="text-[13px] text-[var(--text-muted)]">
            {query.trim() ? "No clients or stores match this search." : "No client campaigns yet."}
          </p>
          {query.trim() && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setQuery("")}>
              Clear search
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
