"use client";

import * as React from "react";
import {
  BarChart3,
  ChevronRight,
  Database,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Store,
  X,
} from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/page-container";
import {
  PERFORMANCE_PROTOTYPE_CLIENTS,
  campaignScaleHistory,
  clientRollup,
  filterPrototypeClients,
  periodScale,
  portfolioRollup,
  prototypePeriodForDays,
  storeRollup,
  type PrototypeCampaign,
  type PrototypeClient,
  type PrototypeStore,
  type PrototypeStoreActivity,
} from "@/lib/admin/performance-prototype";
import { money, multiplier } from "@/lib/format";
import { presetSelection, rangeDays } from "@/lib/portal/range";
import { cn } from "@/lib/utils";

const CAMPAIGN_GRID =
  "xl:grid-cols-[minmax(190px,1.65fr)_repeat(7,minmax(88px,1fr))]";

const scaleDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Lisbon",
});

const scaleDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Lisbon",
});

function SummaryCard({
  label,
  value,
  hint,
  primary = false,
}: {
  label: string;
  value: string;
  hint: string;
  primary?: boolean;
}) {
  return (
    <div
      className={cn(
        "panel min-w-0 p-4",
        primary && "border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)]",
      )}
    >
      <p className="label-caps">{label}</p>
      <p
        className={cn(
          "metric-value mt-1 truncate !text-[24px]",
          primary && "!text-[var(--accent-gold-strong)]",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{hint}</p>
    </div>
  );
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

function OperationalMetric({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "center";
}) {
  return (
    <span
      className={cn(
        "min-w-0",
        align === "center" && "xl:text-center",
      )}
    >
      <span className="label-caps mb-0.5 block xl:hidden">{label}</span>
      <span className="block truncate text-[13px] font-medium tabular-nums text-[var(--text-primary)]">
        {children}
      </span>
    </span>
  );
}

function campaignLabel(campaign: PrototypeCampaign) {
  if (campaign.kind === "demand_gen") return "DGEN";
  return campaign.shoppingFeed ? "PMAX (SF)" : "PMAX";
}

function CampaignRow({
  campaign,
  currency,
  performanceScale,
  scaleHistory,
  onBudgetChange,
  onStatusChange,
}: {
  campaign: PrototypeCampaign;
  currency: PrototypeStore["currency"];
  performanceScale: number;
  scaleHistory: ReturnType<typeof campaignScaleHistory>;
  onBudgetChange: (campaignId: string, dailyBudget: number) => void;
  onStatusChange: (campaignId: string) => void;
}) {
  const inputId = React.useId();
  const errorId = `${inputId}-error`;
  const historyId = `${inputId}-history`;
  const budgetAnchor = React.useRef<HTMLDivElement>(null);
  const editBudgetButton = React.useRef<HTMLButtonElement>(null);
  const restoreBudgetFocus = React.useRef(false);
  const [editingBudget, setEditingBudget] = React.useState(false);
  const [budgetDraft, setBudgetDraft] = React.useState(() => campaign.dailyBudget.toFixed(2));
  const [budgetError, setBudgetError] = React.useState("");
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    if (!editingBudget && restoreBudgetFocus.current) {
      restoreBudgetFocus.current = false;
      editBudgetButton.current?.focus();
    }
  }, [editingBudget]);

  React.useEffect(() => {
    if (!editingBudget) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!budgetAnchor.current?.contains(event.target as Node)) cancelBudgetEdit();
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") cancelBudgetEdit();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  });

  function beginBudgetEdit() {
    setBudgetDraft(campaign.dailyBudget.toFixed(2));
    setBudgetError("");
    setAnnouncement("");
    setEditingBudget(true);
  }

  function cancelBudgetEdit() {
    setBudgetDraft(campaign.dailyBudget.toFixed(2));
    setBudgetError("");
    restoreBudgetFocus.current = true;
    setEditingBudget(false);
  }

  function saveBudget() {
    const parsed = Number(budgetDraft);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setBudgetError("Budget must be at least €1.");
      return;
    }

    const nextBudget = Math.round(parsed * 100) / 100;
    onBudgetChange(campaign.id, nextBudget);
    setBudgetDraft(nextBudget.toFixed(2));
    setBudgetError("");
    restoreBudgetFocus.current = true;
    setEditingBudget(false);
    setAnnouncement(`${campaign.name} daily budget updated to ${money(nextBudget, currency)}.`);
  }

  function handleBudgetKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveBudget();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelBudgetEdit();
    }
  }

  function changeStatus() {
    const nextStatus = campaign.status === "active" ? "paused" : "active";
    onStatusChange(campaign.id);
    setAnnouncement(`${campaign.name} is now ${nextStatus}.`);
  }

  return (
    <li
      className={cn(
        "grid grid-cols-2 items-center gap-x-3 gap-y-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 sm:grid-cols-2 lg:px-5",
        CAMPAIGN_GRID,
      )}
    >
      <div className="col-span-2 min-w-0 xl:col-span-1 xl:pl-6">
        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
          {campaign.name}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {campaign.collection}
        </p>
      </div>

      <div className="min-w-0 xl:text-center">
        <span className="label-caps mb-1 block xl:hidden">Type</span>
        <Badge variant="neutral">{campaignLabel(campaign)}</Badge>
      </div>

      <div className="min-w-0 xl:text-center">
        <span className="label-caps mb-1 block xl:hidden">Status</span>
        <Badge variant={campaign.status === "active" ? "success" : "neutral"}>
          {campaign.status === "active" ? "Active" : "Paused"}
        </Badge>
      </div>

      <span className="col-span-2 sm:col-span-1 xl:col-span-1">
        <OperationalMetric label="Spend" align="center">
          {money(campaign.metrics.spend * performanceScale, currency)}
        </OperationalMetric>
      </span>

      <div className="col-span-2 min-w-0 sm:col-span-1 xl:col-span-1 xl:text-center">
        <span className="label-caps mb-1 block xl:hidden">Daily budget</span>
        <div
          ref={budgetAnchor}
          className="group relative flex min-w-0 items-center gap-1.5 xl:min-h-8 xl:justify-center"
        >
          <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">
            {money(campaign.dailyBudget, currency)}
            <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">/ day</span>
          </span>
          <Button
            ref={editBudgetButton}
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 xl:size-7"
            aria-label={`Edit daily budget for ${campaign.name}`}
            aria-describedby={historyId}
            aria-expanded={editingBudget}
            aria-haspopup="dialog"
            onClick={beginBudgetEdit}
          >
            <Pencil aria-hidden />
          </Button>

          {editingBudget ? (
            <div
              role="dialog"
              aria-label={`Edit daily budget for ${campaign.name}`}
              className="absolute right-0 bottom-[calc(100%+8px)] z-40 w-[min(280px,calc(100vw-32px))] rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-left shadow-2xl xl:right-auto xl:left-1/2 xl:-translate-x-1/2"
            >
              <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                Edit Daily Budget
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">
                {campaign.name}
              </p>
              <label className="label-caps mt-3 block" htmlFor={inputId}>
                Budget per day
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[12px] text-[var(--text-muted)]">
                  €
                </span>
                <Input
                  id={inputId}
                  autoFocus
                  type="number"
                  inputMode="decimal"
                  min="1"
                  step="0.01"
                  value={budgetDraft}
                  aria-invalid={Boolean(budgetError)}
                  aria-describedby={budgetError ? errorId : undefined}
                  className="h-10 pr-3 pl-7 tabular-nums"
                  onChange={(event) => {
                    setBudgetDraft(event.target.value);
                    setBudgetError("");
                  }}
                  onKeyDown={handleBudgetKeyDown}
                />
              </div>
              {budgetError && (
                <p id={errorId} className="mt-1.5 text-[11px] text-[var(--danger-red)]">
                  {budgetError}
                </p>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={cancelBudgetEdit}>
                  Cancel
                </Button>
                <Button type="button" variant="primary" size="sm" onClick={saveBudget}>
                  Save Budget
                </Button>
              </div>
            </div>
          ) : (
            <div
              id={historyId}
              role="tooltip"
              className="pointer-events-none invisible absolute right-0 bottom-[calc(100%+8px)] z-30 w-[min(300px,calc(100vw-32px))] rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-left opacity-0 shadow-2xl transition-[opacity,visibility] group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 xl:right-auto xl:left-1/2 xl:-translate-x-1/2"
            >
              <p className="text-[12px] font-semibold text-[var(--text-primary)]">
                Scale History
              </p>
              {scaleHistory.length > 0 ? (
                <ol className="mt-2 max-h-44 space-y-2 overflow-y-auto">
                  {scaleHistory.map((scale) => (
                    <li key={scale.id} className="border-t border-[var(--border-subtle)] pt-2 first:border-t-0 first:pt-0">
                      <time
                        dateTime={scale.createdAt}
                        className="block text-[10.5px] tabular-nums text-[var(--text-muted)]"
                      >
                        {scaleDateTimeFormatter.format(new Date(scale.createdAt))}
                      </time>
                      <p className="mt-0.5 text-[11.5px] font-medium tabular-nums text-[var(--text-primary)]">
                        {money(scale.previousBudget, currency)} → {money(scale.nextBudget, currency)} / day
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  No budget scales recorded yet.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <OperationalMetric label="ROAS" align="center">
        {multiplier(
          campaign.metrics.spend > 0
            ? campaign.metrics.realRevenue / campaign.metrics.spend
            : 0,
        )}
      </OperationalMetric>

      <OperationalMetric label="Last scaled at" align="center">
        {scaleHistory[0]
          ? scaleDateFormatter.format(new Date(scaleHistory[0].createdAt))
          : "—"}
      </OperationalMetric>

      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="size-10 justify-self-end xl:size-8 xl:justify-self-center"
        aria-label={`${campaign.status === "active" ? "Pause" : "Enable"} ${campaign.name}`}
        title={`${campaign.status === "active" ? "Pause" : "Enable"} ${campaign.name}`}
        onClick={changeStatus}
      >
        {campaign.status === "active" ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </li>
  );
}

function StoreGroup({
  clientId,
  store,
  performanceScale,
  onBudgetChange,
  onStatusChange,
}: {
  clientId: string;
  store: PrototypeStore;
  performanceScale: number;
  onBudgetChange: (campaignId: string, dailyBudget: number) => void;
  onStatusChange: (campaignId: string) => void;
}) {
  const headingId = React.useId();
  const totals = storeRollup(store);
  // Daily budget is the store's current burn rate, so only campaigns that can
  // actually spend today count — a paused campaign's budget is dormant money.
  const dailyBudget = store.campaigns.reduce(
    (sum, campaign) =>
      campaign.status === "active" ? sum + campaign.dailyBudget : sum,
    0,
  );

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
          <h4 id={headingId} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            https://{store.domain}
          </h4>
        </div>

        <Button
          asChild
          variant="secondary"
          size="icon"
          className="size-10 shrink-0 justify-self-center xl:size-8"
        >
          <Link
            href={`/preview/admin/analytics?client=${encodeURIComponent(clientId)}&store=${encodeURIComponent(store.id)}`}
            aria-label={`Open store analytics for ${store.name}`}
            title={`Open store analytics for ${store.name}`}
          >
            <BarChart3 aria-hidden />
          </Link>
        </Button>
      </header>

      {store.campaigns.length > 0 ? (
        <>
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
            <span className="label-caps text-center">ROAS</span>
            <span className="label-caps text-center">Last Scaled at</span>
            <span className="label-caps text-center">Action</span>
          </div>
          <ul>
            <li
              className={cn(
                "grid grid-cols-2 items-center gap-x-3 gap-y-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 sm:grid-cols-2 lg:px-5",
                CAMPAIGN_GRID,
              )}
            >
              <span className="col-span-2 pl-0 text-[12px] font-semibold tracking-[0.08em] text-[var(--text-primary)] xl:col-span-1 xl:pl-6">
                TOTAL
              </span>
              <OperationalMetric label="Type" align="center">—</OperationalMetric>
              <OperationalMetric label="Status" align="center">—</OperationalMetric>
              <OperationalMetric label="Spend" align="center">
                {money(totals.adSpend * performanceScale, store.currency)}
              </OperationalMetric>
              <OperationalMetric label="Daily budget" align="center">
                {money(dailyBudget, store.currency)}
                <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">
                  / day
                </span>
              </OperationalMetric>
              <OperationalMetric label="ROAS" align="center">
                {multiplier(totals.realRoas)}
              </OperationalMetric>
              <OperationalMetric label="Last scaled at" align="center">—</OperationalMetric>
              <span className="hidden xl:block" aria-hidden />
            </li>
            {store.campaigns.map((campaign) => (
              <CampaignRow
                key={campaign.id}
                campaign={campaign}
                currency={store.currency}
                performanceScale={performanceScale}
                scaleHistory={campaignScaleHistory(store, campaign.id)}
                onBudgetChange={onBudgetChange}
                onStatusChange={onStatusChange}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-5 py-5 text-[12.5px] text-[var(--text-muted)]">
          No campaigns in this store.
        </p>
      )}
    </section>
  );
}

function ClientSection({
  client,
  open,
  performanceScale,
  onToggle,
  onBudgetChange,
  onStatusChange,
}: {
  client: PrototypeClient;
  open: boolean;
  performanceScale: number;
  onToggle: () => void;
  onBudgetChange: (storeId: string, campaignId: string, dailyBudget: number) => void;
  onStatusChange: (storeId: string, campaignId: string) => void;
}) {
  const regionId = React.useId();
  const totals = clientRollup(client);

  return (
    <div className="border-t border-[var(--border-subtle)] first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={onToggle}
        className="transition-smooth grid w-full grid-cols-3 items-center gap-x-4 gap-y-3 px-4 py-4 text-left outline-none hover:bg-[var(--bg-panel-hover)] focus-visible:bg-[var(--bg-panel-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/30 md:grid-cols-[minmax(260px,1.6fr)_repeat(3,minmax(100px,.65fr))] md:px-5"
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
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
              {client.name}
            </span>
            <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-muted)]">
              {client.stores.length} {client.stores.length === 1 ? "store" : "stores"} · {client.email}
            </span>
          </span>
        </span>

        <ClientMetric label="Revenue">{money(totals.revenue * performanceScale, client.currency)}</ClientMetric>
        <ClientMetric label="Ad spend">{money(totals.adSpend * performanceScale, client.currency)}</ClientMetric>
        <ClientMetric label="Real ROAS">{multiplier(totals.realRoas)}</ClientMetric>
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
              performanceScale={performanceScale}
              onBudgetChange={(campaignId, dailyBudget) =>
                onBudgetChange(store.id, campaignId, dailyBudget)
              }
              onStatusChange={(campaignId) => onStatusChange(store.id, campaignId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NewCampaignPlaceholder() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="primary" size="sm">
          <Plus aria-hidden />
          New Campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Campaign</DialogTitle>
          <DialogDescription>
            Campaign creation will get its own flow after the Demand Gen and PMax setup rules are
            defined.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          This prototype stops before creating anything. No Google Ads account, budget or creative
          is changed from here.
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary" size="sm">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CampaignsPrototype() {
  const [range, setRange] = React.useState(() => presetSelection("d7"));
  const [clientQuery, setClientQuery] = React.useState("");
  const [clients, setClients] = React.useState<PrototypeClient[]>(() =>
    PERFORMANCE_PROTOTYPE_CLIENTS.map((client) => ({
      ...client,
      stores: client.stores.map((store) => ({
        ...store,
        campaigns: store.campaigns.map((campaign) => ({ ...campaign })),
      })),
    })),
  );
  const [openClients, setOpenClients] = React.useState<Set<string>>(
    () => new Set(PERFORMANCE_PROTOTYPE_CLIENTS.slice(0, 1).map((client) => client.id)),
  );
  const [syncing, setSyncing] = React.useState(false);
  const [syncedAt, setSyncedAt] = React.useState<string | null>(null);
  const syncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  const totals = React.useMemo(() => portfolioRollup(clients), [clients]);
  const visibleClients = React.useMemo(
    () => filterPrototypeClients(clients, clientQuery),
    [clientQuery, clients],
  );
  const performanceScale = periodScale(prototypePeriodForDays(rangeDays(range)));

  function toggleClient(clientId: string) {
    setOpenClients((current) => {
      const next = new Set(current);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function updateCampaign(
    clientId: string,
    storeId: string,
    campaignId: string,
    update: (campaign: PrototypeCampaign) => PrototypeCampaign,
  ) {
    setClients((current) =>
      current.map((client) =>
        client.id !== clientId
          ? client
          : {
              ...client,
              stores: client.stores.map((store) =>
                store.id !== storeId
                  ? store
                  : {
                      ...store,
                      campaigns: store.campaigns.map((campaign) =>
                        campaign.id === campaignId ? update(campaign) : campaign,
                      ),
                    },
              ),
            },
      ),
    );
  }

  function changeBudget(
    clientId: string,
    storeId: string,
    campaignId: string,
    dailyBudget: number,
  ) {
    const nextBudget = Math.max(1, Math.round(dailyBudget * 100) / 100);
    setClients((current) =>
      current.map((client) =>
        client.id !== clientId
          ? client
          : {
              ...client,
              stores: client.stores.map((store) => {
                if (store.id !== storeId) return store;
                const campaign = store.campaigns.find((entry) => entry.id === campaignId);
                if (!campaign || campaign.dailyBudget === nextBudget) return store;
                const activity: PrototypeStoreActivity = {
                  id: `${campaignId}-budget-${Date.now()}`,
                  createdAt: new Date().toISOString(),
                  actor: "Bruno Oliveira",
                  campaignId,
                  campaignName: campaign.name,
                  action: "budget_changed",
                  previousBudget: campaign.dailyBudget,
                  nextBudget,
                };
                return {
                  ...store,
                  campaigns: store.campaigns.map((entry) =>
                    entry.id === campaignId ? { ...entry, dailyBudget: nextBudget } : entry,
                  ),
                  activity: [activity, ...store.activity],
                };
              }),
            },
      ),
    );
  }

  function toggleCampaignStatus(clientId: string, storeId: string, campaignId: string) {
    updateCampaign(clientId, storeId, campaignId, (campaign) => ({
      ...campaign,
      status: campaign.status === "active" ? "paused" : "active",
    }));
  }

  function sync() {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncing(true);
    syncTimer.current = setTimeout(() => {
      setSyncing(false);
      setSyncedAt(
        new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      );
      syncTimer.current = null;
    }, 700);
  }

  return (
    <PageContainer
      title="Campaigns"
      description={
        <>
          Portfolio performance and active campaign controls · {range.from} → {range.to}
          {syncedAt && (
            <span className="ml-1 text-[var(--success-green)]" role="status" aria-live="polite">
              · mock data synced at {syncedAt}
            </span>
          )}
        </>
      }
      actions={
        <>
          <Badge variant="neutral" className="hidden sm:inline-flex">
            <Database className="size-3" aria-hidden />
            Prototype data
          </Badge>
          <NewCampaignPlaceholder />
          <Button type="button" variant="secondary" size="sm" loading={syncing} onClick={sync}>
            <RefreshCw aria-hidden />
            Sync
          </Button>
          <DateRangePicker value={range} onApply={setRange} />
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SummaryCard
            label="Revenue"
            value={money(totals.revenue * performanceScale, "EUR")}
            hint="Shopify revenue across all client stores"
            primary
          />
          <SummaryCard
            label="Real ROAS"
            value={multiplier(totals.realRoas)}
            hint="Shopify revenue ÷ total ad spend"
            primary
          />
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard
            label="Ad spend"
            value={money(totals.adSpend * performanceScale, "EUR")}
            hint="Across mapped ad accounts"
          />
          <SummaryCard
            label="Agency commission"
            value={money(totals.agencyCommission * performanceScale, "EUR")}
            hint="Based on each store rate"
          />
          <SummaryCard
            label="Active campaigns"
            value={String(totals.activeCampaigns)}
            hint="Enabled in this prototype"
          />
          <SummaryCard
            label="Connected accounts"
            value={String(totals.connectedAccounts)}
            hint="Mapped Shopify and Google pairs"
          />
        </div>

        <section className="panel overflow-hidden">
          <header className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-4 py-4 md:flex-row md:items-end md:justify-between md:px-5">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                Client performance
              </h2>
              <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                Open a client to see every store and manage its campaigns.
              </p>
            </div>

            <form
              role="search"
              className="w-full md:w-[320px]"
              onSubmit={(event) => event.preventDefault()}
            >
              <label className="sr-only" htmlFor="campaign-client-search">
                Search clients or stores
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                  aria-hidden
                />
                <Input
                  id="campaign-client-search"
                  type="search"
                  value={clientQuery}
                  onChange={(event) => setClientQuery(event.target.value)}
                  placeholder="Search clients or stores"
                  className="pl-9 pr-9"
                />
                {clientQuery && (
                  <button
                    type="button"
                    className="focus-ring absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    onClick={() => setClientQuery("")}
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
                performanceScale={performanceScale}
                onToggle={() => toggleClient(client.id)}
                onBudgetChange={(storeId, campaignId, dailyBudget) =>
                  changeBudget(client.id, storeId, campaignId, dailyBudget)
                }
                onStatusChange={(storeId, campaignId) =>
                  toggleCampaignStatus(client.id, storeId, campaignId)
                }
              />
            ))
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <p className="text-[13px] text-[var(--text-muted)]">
                {clientQuery.trim()
                  ? "No clients or stores match this search."
                  : "No clients in this prototype."}
              </p>
              {clientQuery.trim() && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setClientQuery("")}>
                  Clear search
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
