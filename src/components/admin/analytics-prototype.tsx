"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Database,
  History,
  ImageIcon,
  MousePointerClick,
  Package,
  Pencil,
  RefreshCw,
  Search,
  ShoppingBag,
  Store as StoreIcon,
  Users,
  Video,
  X,
} from "lucide-react";

import {
  FunnelDevelopmentChart,
  RoasEvolutionHover,
  SpendDevelopmentChart,
  type PerformanceChartPoint,
  type RoasEvolutionWindows,
} from "@/components/admin/performance-charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/page-container";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PERFORMANCE_PROTOTYPE_CLIENTS,
  PROTOTYPE_PERIODS,
  estimatedProfit,
  filterPrototypeClients,
  googleMetrics,
  performancePointsForPeriod,
  periodScale,
  pmaxProductsWithSpend,
  storeRollup,
  type PrototypeCampaign,
  type PrototypeClient,
  type PrototypeCollection,
  type PrototypeMetricSet,
  type PrototypePeriod,
  type PrototypeStore,
  type PrototypeStoreActivity,
} from "@/lib/admin/performance-prototype";
import { integer, money, multiplier, percent } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL_STORES = "all";
const DEFAULT_COG = 15;

function ClientCombobox({
  value,
  onValueChange,
  labelledBy,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
  labelledBy: string;
}) {
  const selectedClient = PERFORMANCE_PROTOTYPE_CLIENTS.find((client) => client.id === value) ?? null;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId().replaceAll(":", "");
  const popupId = `${id}-popup`;
  const listboxId = `${id}-clients`;
  const valueId = `${id}-value`;
  const clients = filterPrototypeClients(PERFORMANCE_PROTOTYPE_CLIENTS, query);
  const options: Array<PrototypeClient | null> = query.trim() ? clients : [null, ...clients];

  React.useEffect(() => {
    if (!open) return;

    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  React.useEffect(() => {
    if (open && options.length > 0) {
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, id, open, options.length]);

  function openList() {
    setQuery("");
    setActiveIndex(selectedClient
      ? PERFORMANCE_PROTOTYPE_CLIENTS.findIndex((client) => client.id === selectedClient.id) + 1
      : 0);
    setOpen(true);
  }

  function selectClient(client: PrototypeClient | null) {
    onValueChange(client?.id ?? null);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(options.length - 1, 0));
    } else if (event.key === "Enter" && activeIndex >= 0 && activeIndex < options.length) {
      event.preventDefault();
      selectClient(options[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        className={cn(
          "transition-smooth flex h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 text-sm text-[var(--text-primary)]",
          "hover:border-[var(--border-strong)] focus:outline-none focus-visible:border-[var(--accent-gold)]/50 focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15",
        )}
        onClick={() => open ? setOpen(false) : openList()}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openList();
          }
        }}
      >
        <span id={valueId} className="truncate">{selectedClient?.name ?? "All clients"}</span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
      </button>

      {open && (
        <div id={popupId} role="dialog" aria-label="Choose client" className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-xl shadow-black/40">
          <div className="relative border-b border-[var(--border-subtle)] p-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <Input
              ref={inputRef}
              role="combobox"
              aria-label="Search clients by name"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={options.length > 0 ? `${id}-option-${activeIndex}` : undefined}
              autoComplete="off"
              value={query}
              placeholder="Search client name…"
              className="h-8 bg-[var(--bg-panel)] pr-2 pl-8 text-[13px]"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </div>

          <ul id={listboxId} role="listbox" aria-label="Clients" className="max-h-60 overflow-y-auto p-1">
            {options.map((client, index) => {
              const selected = client ? client.id === value : value === null;
              const label = client?.name ?? "All clients";
              return (
                <li
                  key={client?.id ?? "all-clients"}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "transition-smooth relative flex min-h-9 cursor-pointer items-center rounded-lg py-2 pr-8 pl-2.5 text-[13px] text-[var(--text-primary)] outline-none select-none",
                    index === activeIndex && "bg-[var(--bg-panel-hover)]",
                  )}
                  onPointerMove={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectClient(client)}
                >
                  <span className="truncate">{label}</span>
                  {selected && <Check className="absolute right-2.5 size-3.5 text-[var(--accent-gold)]" aria-hidden />}
                </li>
              );
            })}
          </ul>
          {options.length === 0 && (
            <p role="status" className="px-2.5 py-3 text-center text-[12px] text-[var(--text-muted)]">
              No clients match “{query.trim()}”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function scaledMetrics(metrics: PrototypeMetricSet, scale: number): PrototypeMetricSet {
  return {
    spend: metrics.spend * scale,
    impressions: metrics.impressions * scale,
    clicks: metrics.clicks * scale,
    conversions: metrics.conversions * scale,
    googleRevenue: metrics.googleRevenue * scale,
    realRevenue: metrics.realRevenue * scale,
  };
}

function roasWindows(revenue: number, spend: number, seed: string): RoasEvolutionWindows {
  if (spend <= 0) {
    return { d30: null, d14: null, d7: null, d3: null, yesterday: null, today: null };
  }

  const base = revenue / spend;
  const drift = (seed.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 9) / 100;
  return {
    d30: base * (0.95 + drift),
    d14: base * (1.01 - drift / 2),
    d7: base * (1.04 + drift / 3),
    d3: base * (0.98 + drift),
    yesterday: base * (1.06 - drift),
    today: base * (1.02 + drift / 2),
  };
}

function metricMultiplier(value: number, denominator: number) {
  return denominator > 0 ? multiplier(value / denominator) : "—";
}

function KpiCard({
  label,
  value,
  hint,
  tone = "default",
  action,
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone?: "default" | "gold" | "positive" | "negative";
  action?: React.ReactNode;
}) {
  return (
    <div className="panel flex min-h-[104px] min-w-0 flex-col justify-between gap-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="label-caps">{label}</p>
        {action}
      </div>
      <div
        className={cn(
          "text-[clamp(19px,1.7vw,24px)] leading-none font-semibold tracking-[-0.02em] tabular-nums",
          tone === "gold" && "text-[var(--accent-gold-strong)]",
          tone === "positive" && "text-[var(--success-green)]",
          tone === "negative" && "text-[var(--danger-red)]",
          tone === "default" && "text-[var(--text-primary)]",
        )}
      >
        {value}
      </div>
      <p className="text-[10.5px] leading-snug text-[var(--text-muted)]">{hint}</p>
    </div>
  );
}

function AllClientsSummary({
  onSelectClient,
  onSelectStore,
}: {
  onSelectClient: (clientId: string) => void;
  onSelectStore: (clientId: string, storeId: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const clients = filterPrototypeClients(PERFORMANCE_PROTOTYPE_CLIENTS, query);

  return (
    <section className="panel overflow-hidden" aria-labelledby="all-clients-heading">
      <header className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5 sm:flex-row sm:items-end sm:justify-between md:px-5">
        <div>
          <h2 id="all-clients-heading" className="text-[14px] font-semibold text-[var(--text-primary)]">All clients</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Choose a client or open one of its Shopify stores.</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
          <Input
            type="search"
            value={query}
            placeholder="Search client name…"
            aria-label="Search all clients by name"
            className="h-9 pr-3 pl-9 text-[13px]"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </header>

      {clients.length > 0 ? (
        <div>
          {clients.map((client, clientIndex) => (
            <article key={client.id} className={clientIndex > 0 ? "border-t border-[var(--border-subtle)]" : undefined}>
              <button
                type="button"
                className="transition-smooth flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/35 md:px-5"
                onClick={() => onSelectClient(client.id)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
                  <Users className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">{client.name}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">{client.email}</span>
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">{client.stores.length} {client.stores.length === 1 ? "store" : "stores"}</span>
                <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
              </button>

              <ul className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                {client.stores.map((store) => (
                  <li key={store.id}>
                    <button
                      type="button"
                      className="transition-smooth flex min-h-11 w-full items-center gap-3 border-t border-[var(--border-subtle)] px-4 py-2 text-left first:border-t-0 hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/35 md:px-5 md:pl-16"
                      aria-label={`Open ${store.domain} for ${client.name}`}
                      onClick={() => onSelectStore(client.id, store.id)}
                    >
                      <StoreIcon className="size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-[var(--text-primary)]">{store.domain}</span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">{store.name}</span>
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : (
        <div role="status" className="flex min-h-32 flex-col items-center justify-center px-4 py-6 text-center">
          <Search className="size-5 text-[var(--text-muted)]" aria-hidden />
          <p className="mt-2 text-[13px] font-medium text-[var(--text-primary)]">No clients match “{query.trim()}”</p>
          <button type="button" className="mt-2 text-[12px] font-medium text-[var(--accent-gold-strong)] hover:underline" onClick={() => setQuery("")}>Clear search</button>
        </div>
      )}
    </section>
  );
}

function AllStoresSummary({
  client,
  cogs,
  period,
  onSelectStore,
}: {
  client: PrototypeClient;
  cogs: Record<string, number>;
  period: PrototypePeriod;
  onSelectStore: (storeId: string) => void;
}) {
  const scale = periodScale(period);
  const rows = client.stores.map((store) => {
    const rollup = storeRollup(store);
    const revenue = store.revenue * scale;
    const adSpend = rollup.adSpend * scale;
    const units = Math.round(store.units * scale);
    const estimatedCog = units * (cogs[store.id] ?? DEFAULT_COG);
    return {
      store,
      revenue,
      adSpend,
      estimatedCog,
      profit: revenue - adSpend - estimatedCog,
    };
  });
  const totals = rows.reduce(
    (sum, row) => ({
      revenue: sum.revenue + row.revenue,
      adSpend: sum.adSpend + row.adSpend,
      estimatedCog: sum.estimatedCog + row.estimatedCog,
      profit: sum.profit + row.profit,
    }),
    { revenue: 0, adSpend: 0, estimatedCog: 0, profit: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Revenue" value={money(totals.revenue, client.currency)} hint="All Shopify stores" />
        <KpiCard label="Ad spend" value={money(totals.adSpend, client.currency)} hint="Mapped Google accounts" />
        <KpiCard label="Estimated COG" value={money(totals.estimatedCog, client.currency)} hint="Total estimated goods cost" />
        <KpiCard label="Real ROAS" value={metricMultiplier(totals.revenue, totals.adSpend)} hint="Shopify revenue ÷ ad spend" tone="gold" />
        <KpiCard
          label="Estimated profit"
          value={money(totals.profit, client.currency)}
          hint="Revenue − spend − estimated COG"
          tone={totals.profit >= 0 ? "positive" : "negative"}
        />
      </div>

      <section className="panel overflow-hidden">
        <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 md:px-5">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">All Stores</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Open a Shopify store to review its funnel, campaigns and collections.
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-[12px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
                <th className="px-5 py-2.5 font-medium">Store URL</th>
                <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
                <th className="px-3 py-2.5 text-right font-medium">Ad spend</th>
                <th className="px-3 py-2.5 text-right font-medium">Est. COG</th>
                <th className="px-3 py-2.5 text-right font-medium">Real ROAS</th>
                <th className="px-3 py-2.5 text-right font-medium">Est. profit</th>
                <th className="px-5 py-2.5"><span className="sr-only">Open store</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ store, revenue, adSpend, estimatedCog, profit }) => (
                <tr key={store.id} className="transition-smooth border-t border-[var(--border-subtle)] hover:bg-[var(--bg-panel-hover)]">
                  <td className="px-5 py-3">
                    <p className="font-medium text-[var(--text-primary)]">{store.domain}</p>
                    <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">{store.name}</p>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{money(revenue, store.currency)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{money(adSpend, store.currency)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{money(estimatedCog, store.currency)}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums text-[var(--accent-gold-strong)]">
                    {metricMultiplier(revenue, adSpend)}
                  </td>
                  <td className={cn("px-3 py-3 text-right font-medium tabular-nums", profit >= 0 ? "text-[var(--success-green)]" : "text-[var(--danger-red)]")}>
                    {money(profit, store.currency)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button type="button" variant="ghost" size="icon" aria-label={`Open ${store.domain}`} onClick={() => onSelectStore(store.id)}>
                      <ChevronRight aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const TONE_CLASS = {
  gold: "from-[#d4a86a]/45 to-[#302414] text-[#f2d7ae]",
  blue: "from-[#4d91c9]/45 to-[#142332] text-[#b9dcf4]",
  violet: "from-[#8c6bc9]/45 to-[#231a35] text-[#d8c8f5]",
  green: "from-[#6fae7a]/45 to-[#162a1a] text-[#c6e8cc]",
} as const;

type BreakdownRow = {
  id: string;
  name: string;
  detail: string;
  tone: keyof typeof TONE_CLASS;
  kind: "video" | "image" | "product";
  metrics: PrototypeMetricSet;
};

function breakdownRows(campaign: PrototypeCampaign): BreakdownRow[] {
  if (campaign.kind === "demand_gen") {
    return campaign.creatives.map((creative) => ({
      id: creative.id,
      name: creative.name,
      detail: `${creative.format} creative`,
      tone: creative.tone,
      kind: creative.format,
      metrics: creative.metrics,
    }));
  }

  return pmaxProductsWithSpend(campaign).map((product) => ({
    id: product.id,
    name: product.name,
    detail: product.sku,
    tone: product.tone,
    kind: "product",
    metrics: product.metrics,
  }));
}

function TrackingCell({ metrics, seed }: { metrics: PrototypeMetricSet; seed: string }) {
  return (
    <RoasEvolutionHover windows={roasWindows(metrics.realRevenue, metrics.spend, seed)} />
  );
}

function MetricCells({ metrics, currency }: { metrics: PrototypeMetricSet; currency: string }) {
  const values = googleMetrics(metrics);
  return (
    <>
      <td className="px-2.5 py-3 text-right tabular-nums">{money(metrics.spend, currency)}</td>
      <td className="px-2.5 py-3 text-right tabular-nums">{money(values.cpc, currency)}</td>
      <td className="px-2.5 py-3 text-right tabular-nums">{percent(values.ctr)}</td>
      <td className="px-2.5 py-3 text-right tabular-nums">{money(values.cpm, currency)}</td>
      <td className="px-2.5 py-3 text-right tabular-nums">{money(values.cpa, currency)}</td>
      <td className="px-2.5 py-3 text-right tabular-nums">{integer(metrics.conversions)}</td>
      <td className="px-2.5 py-3 text-right font-medium tabular-nums">{multiplier(values.googleRoas)}</td>
      <td className="px-2.5 py-3 text-right font-medium tabular-nums text-[var(--accent-gold-strong)]">{multiplier(values.realRoas)}</td>
    </>
  );
}

function BreakdownIdentity({ row }: { row: BreakdownRow }) {
  const Icon = row.kind === "video" ? Video : row.kind === "image" ? ImageIcon : Package;
  return (
    <div className="flex items-center gap-2.5 pl-5">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-br", TONE_CLASS[row.tone])}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-[var(--text-primary)]">{row.name}</span>
        <span className="block text-[10px] capitalize text-[var(--text-muted)]">{row.detail}</span>
      </span>
    </div>
  );
}

function CampaignPerformance({
  store,
  period,
  initialCampaignId,
}: {
  store: PrototypeStore;
  period: PrototypePeriod;
  initialCampaignId?: string;
}) {
  const [openCampaigns, setOpenCampaigns] = React.useState<Set<string>>(
    () => new Set(initialCampaignId ? [initialCampaignId] : []),
  );
  const scale = periodScale(period);

  function toggle(id: string) {
    setOpenCampaigns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="panel overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5 md:px-5">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Campaign Performance</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Demand Gen opens creatives; PMax opens only products with spend.
          </p>
        </div>
        <Badge variant="neutral">Real ROAS is estimated</Badge>
      </header>

      {store.campaigns.length === 0 ? (
        <p className="px-5 py-10 text-center text-[12px] text-[var(--text-muted)]">No campaigns mapped to this store.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1250px] text-[11.5px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
                <th className="px-5 py-2.5 font-medium">Campaign / asset</th>
                <th className="px-2.5 py-2.5 font-medium">Type</th>
                <th className="px-2.5 py-2.5 text-right font-medium">Spend</th>
                <th className="px-2.5 py-2.5 text-right font-medium">CPC</th>
                <th className="px-2.5 py-2.5 text-right font-medium">CTR</th>
                <th className="px-2.5 py-2.5 text-right font-medium">CPM</th>
                <th className="px-2.5 py-2.5 text-right font-medium">CPA</th>
                <th className="px-2.5 py-2.5 text-right font-medium">Conv.</th>
                <th className="px-2.5 py-2.5 text-right font-medium">ROAS</th>
                <th className="px-2.5 py-2.5 text-right font-medium">Real ROAS</th>
                <th className="px-5 py-2.5 text-right font-medium">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {store.campaigns.map((campaign) => {
                const open = openCampaigns.has(campaign.id);
                const metrics = scaledMetrics(campaign.metrics, scale);
                return (
                  <React.Fragment key={campaign.id}>
                    <tr className="transition-smooth border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]">
                      <td className="px-5 py-3">
                        <button type="button" aria-expanded={open} onClick={() => toggle(campaign.id)} className="flex min-h-8 max-w-[330px] items-center gap-2 text-left outline-none focus-visible:text-[var(--accent-gold-strong)]">
                          <ChevronRight className={cn("transition-smooth size-3.5 shrink-0 text-[var(--text-muted)]", open && "rotate-90")} aria-hidden />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[var(--text-primary)]">{campaign.name}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">{campaign.collection}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-2.5 py-3">
                        <Badge variant={campaign.kind === "demand_gen" ? "gold" : "neutral"}>
                          {campaign.kind === "demand_gen" ? "Demand Gen" : "PMax"}
                        </Badge>
                      </td>
                      <MetricCells metrics={metrics} currency={store.currency} />
                      <td className="px-5 py-2 text-right"><TrackingCell metrics={metrics} seed={campaign.id} /></td>
                    </tr>

                    {open && breakdownRows(campaign).map((row) => {
                      const detailMetrics = scaledMetrics(row.metrics, scale);
                      return (
                        <tr key={row.id} className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-panel-hover)]">
                          <td className="px-5 py-2.5"><BreakdownIdentity row={row} /></td>
                          <td className="px-2.5 py-2.5 text-[10.5px] capitalize text-[var(--text-secondary)]">{row.detail}</td>
                          <MetricCells metrics={detailMetrics} currency={store.currency} />
                          <td className="px-5 py-2 text-right"><TrackingCell metrics={detailMetrics} seed={row.id} /></td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ShopifyFunnel({ points }: { points: PerformanceChartPoint[] }) {
  const totals = points.reduce(
    (sum, point) => ({
      sessions: sum.sessions + point.sessions,
      addToCarts: sum.addToCarts + point.addToCarts,
      checkouts: sum.checkouts + point.checkouts,
      conversions: sum.conversions + point.conversions,
    }),
    { sessions: 0, addToCarts: 0, checkouts: 0, conversions: 0 },
  );
  const steps = [
    { label: "Sessions", value: totals.sessions, icon: Users },
    { label: "Add to cart", value: totals.addToCarts, icon: MousePointerClick },
    { label: "Checkout", value: totals.checkouts, icon: CreditCard },
    { label: "Conversions", value: totals.conversions, icon: CheckCircle2 },
  ];

  return (
    <section className="panel p-4">
      <header className="mb-3">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Shopify Funnel</h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Store behaviour across the selected period.</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => {
          const fromSessions = steps[0].value > 0 ? step.value / steps[0].value : 0;
          const Icon = step.icon;
          return (
            <div key={step.label} className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="label-caps">{step.label}</p>
                <Icon className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
              </div>
              <p className="mt-1.5 text-[20px] font-semibold tabular-nums text-[var(--text-primary)]">
                {index === 0 ? integer(step.value) : percent(fromSessions, index === 3 ? 2 : 1)}
              </p>
              <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                <span className="block h-full rounded-full bg-[var(--accent-gold)]" style={{ width: `${Math.max(3, fromSessions * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                {index === 0 ? "100% of visits" : `${integer(step.value)} events`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CollectionReturn({
  collections,
  currency,
  period,
}: {
  collections: PrototypeCollection[];
  currency: string;
  period: PrototypePeriod;
}) {
  const [openCollections, setOpenCollections] = React.useState<Set<string>>(new Set());
  const scale = periodScale(period);

  function toggle(id: string) {
    setOpenCollections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 md:px-5">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Return by Collection</h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Open a collection to see the products behind its return.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[11.5px]">
          <thead>
            <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
              <th className="px-5 py-2.5 font-medium">Collection / product</th>
              <th className="px-3 py-2.5 font-medium">Sources</th>
              <th className="px-3 py-2.5 text-right font-medium">Units</th>
              <th className="px-3 py-2.5 text-right font-medium">Ad spend</th>
              <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
              <th className="px-3 py-2.5 text-right font-medium">Real ROAS</th>
              <th className="px-5 py-2.5 text-right font-medium">Tracking</th>
            </tr>
          </thead>
          <tbody>
            {collections.map((collection) => {
              const open = openCollections.has(collection.id);
              const spend = collection.adSpend * scale;
              const revenue = collection.revenue * scale;
              return (
                <React.Fragment key={collection.id}>
                  <tr
                    className="transition-smooth cursor-pointer border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]"
                    onClick={() => toggle(collection.id)}
                  >
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(collection.id);
                        }}
                        className="flex min-h-8 items-center gap-2 text-left font-medium text-[var(--text-primary)] outline-none focus-visible:text-[var(--accent-gold-strong)]"
                      >
                        <ChevronRight className={cn("transition-smooth size-3.5 text-[var(--text-muted)]", open && "rotate-90")} aria-hidden />
                        {collection.name}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {collection.sources.length > 0 ? collection.sources.map((source) => (
                          <Badge key={source} variant={source === "demand_gen" ? "gold" : "neutral"}>{source === "demand_gen" ? "Demand Gen" : "PMax"}</Badge>
                        )) : <span className="text-[var(--text-muted)]">Organic / unmapped</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{integer(collection.units * scale)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(spend, currency)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(revenue, currency)}</td>
                    <td className="px-3 py-3 text-right font-medium tabular-nums text-[var(--accent-gold-strong)]">{metricMultiplier(revenue, spend)}</td>
                    <td className="px-5 py-2 text-right" onClick={(event) => event.stopPropagation()}><RoasEvolutionHover windows={roasWindows(revenue, spend, collection.id)} /></td>
                  </tr>

                  {open && collection.products.map((product) => {
                    const productSpend = product.adSpend * scale;
                    const productRevenue = product.revenue * scale;
                    return (
                      <tr key={product.id} className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-panel-hover)]">
                        <td className="px-5 py-2.5 pl-12 font-medium text-[var(--text-secondary)]">{product.name}</td>
                        <td className="px-3 py-2.5 text-[var(--text-muted)]">Product</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{integer(product.units * scale)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(productSpend, currency)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(productRevenue, currency)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[var(--accent-gold-strong)]">{metricMultiplier(productRevenue, productSpend)}</td>
                        <td className="px-5 py-2 text-right"><RoasEvolutionHover windows={roasWindows(productRevenue, productSpend, product.id)} /></td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const activityDateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Lisbon",
});

function activityPresentation(activity: PrototypeStoreActivity, currency: string) {
  switch (activity.action) {
    case "budget_changed":
      return {
        label: "Budget Changed",
        detail: `${money(activity.previousBudget, currency)}/day → ${money(activity.nextBudget, currency)}/day`,
        variant: "gold" as const,
      };
    case "campaign_paused":
      return {
        label: "Campaign Paused",
        detail: "Campaign delivery stopped",
        variant: "warning" as const,
      };
    case "campaign_enabled":
      return {
        label: "Campaign Enabled",
        detail: "Campaign delivery resumed",
        variant: "success" as const,
      };
    case "campaign_launched":
      return {
        label: "Campaign Launched",
        detail: `Started at ${money(activity.dailyBudget, currency)}/day`,
        variant: "success" as const,
      };
  }
}

function StoreActivityLog({
  activity,
  currency,
}: {
  activity: PrototypeStoreActivity[];
  currency: string;
}) {
  const activityGrid =
    "md:grid-cols-[minmax(150px,.7fr)_minmax(170px,.85fr)_minmax(230px,1.35fr)_minmax(140px,.7fr)]";

  return (
    <section className="panel overflow-hidden">
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5 md:px-5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--accent-gold)]">
          <History className="size-3.5" aria-hidden />
        </span>
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
            Store Activity Log
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Campaign and budget changes recorded for this store and its ad account.
          </p>
        </div>
      </header>

      {activity.length > 0 ? (
        <div>
          <div
            className={cn(
              activityGrid,
              "label-caps hidden gap-x-4 border-b border-[var(--border-subtle)] px-5 py-2.5 md:grid",
            )}
          >
            <span>Time</span>
            <span>Change</span>
            <span>Campaign</span>
            <span>Changed By</span>
          </div>
          <ol>
            {activity.map((entry) => {
              const presentation = activityPresentation(entry, currency);
              return (
                <li
                  key={entry.id}
                  className={cn(
                    activityGrid,
                    "grid grid-cols-1 gap-3 border-t border-[var(--border-subtle)] px-4 py-3 first:border-t-0 sm:grid-cols-2 md:gap-x-4 md:px-5",
                  )}
                >
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block md:hidden">Time</span>
                    <time
                      dateTime={entry.createdAt}
                      className="text-[11.5px] tabular-nums text-[var(--text-secondary)]"
                    >
                      {activityDateFormatter.format(new Date(entry.createdAt))}
                    </time>
                  </div>
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block md:hidden">Change</span>
                    <Badge variant={presentation.variant}>{presentation.label}</Badge>
                    <p className="mt-1 text-[10.5px] tabular-nums text-[var(--text-muted)]">
                      {presentation.detail}
                    </p>
                  </div>
                  <div className="min-w-0 sm:col-span-2 md:col-span-1">
                    <span className="label-caps mb-1 block md:hidden">Campaign</span>
                    <p className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                      {entry.campaignName}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block md:hidden">Changed By</span>
                    <p className="truncate text-[11.5px] text-[var(--text-secondary)]">
                      {entry.actor}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="px-5 py-10 text-center text-[12px] text-[var(--text-muted)]">
          No campaign changes have been recorded for this store yet.
        </p>
      )}
    </section>
  );
}

function StoreAnalytics({
  store,
  averageCog,
  onAverageCogChange,
  period,
  initialCampaignId,
}: {
  store: PrototypeStore;
  averageCog: number;
  onAverageCogChange: (value: number) => void;
  period: PrototypePeriod;
  initialCampaignId?: string;
}) {
  const scale = periodScale(period);
  const totals = storeRollup(store);
  const revenue = store.revenue * scale;
  const adSpend = totals.adSpend * scale;
  const units = Math.round(store.units * scale);
  const totalCog = units * averageCog;
  const profit = estimatedProfit(revenue, adSpend, units, averageCog);
  const points = performancePointsForPeriod(store, period, averageCog);
  const granularity = period === "today" || period === "d3" || period === "d7" ? "hour" : "day";
  const [editingCog, setEditingCog] = React.useState(false);
  const [cogDraft, setCogDraft] = React.useState(() => averageCog.toFixed(2));
  const [cogError, setCogError] = React.useState("");

  function cancelCog() {
    setCogDraft(averageCog.toFixed(2));
    setCogError("");
    setEditingCog(false);
  }

  function saveCog() {
    const parsed = Number(cogDraft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setCogError("Enter a valid cost of zero or more.");
      return;
    }
    onAverageCogChange(Math.round(parsed * 100) / 100);
    setCogError("");
    setEditingCog(false);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Revenue" value={money(revenue, store.currency)} hint="Shopify store revenue" />
        <KpiCard label="Ad spend" value={money(adSpend, store.currency)} hint="Mapped Google account" />
        <KpiCard
          label="Estimated COG"
          value={editingCog ? (
            <span className="flex items-center gap-1.5">
              <input
                autoFocus
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={cogDraft}
                aria-label="Average cost of goods per unit"
                aria-invalid={Boolean(cogError)}
                onChange={(event) => { setCogDraft(event.target.value); setCogError(""); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCog();
                  if (event.key === "Escape") cancelCog();
                }}
                className="h-8 w-[86px] rounded-[8px] border border-[var(--accent-gold)]/40 bg-[var(--bg-base)] px-2 text-[15px] outline-none"
              />
              <span className="text-[10px] font-normal text-[var(--text-muted)]">/ unit</span>
              <button type="button" aria-label="Save average COG" className="flex size-7 items-center justify-center rounded-[7px] text-[var(--success-green)] hover:bg-[var(--bg-panel-hover)]" onClick={saveCog}><Check className="size-3.5" aria-hidden /></button>
              <button type="button" aria-label="Cancel average COG edit" className="flex size-7 items-center justify-center rounded-[7px] text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)]" onClick={cancelCog}><X className="size-3.5" aria-hidden /></button>
            </span>
          ) : money(totalCog, store.currency)}
          hint={cogError || `${integer(units)} units × ${money(averageCog, store.currency)}/unit`}
          action={!editingCog ? (
            <button type="button" className="transition-smooth flex size-7 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]" aria-label="Edit average COG" onClick={() => setEditingCog(true)}>
              <Pencil className="size-3.5" aria-hidden />
            </button>
          ) : null}
        />
        <KpiCard label="Real ROAS" value={metricMultiplier(revenue, adSpend)} hint="Shopify revenue ÷ ad spend" tone="gold" />
        <KpiCard label="Estimated profit" value={money(profit, store.currency)} hint="Revenue − spend − estimated COG" tone={profit >= 0 ? "positive" : "negative"} />
      </div>

      <FunnelDevelopmentChart points={points} currency={store.currency} granularity={granularity} />
      <ShopifyFunnel points={points} />
      <SpendDevelopmentChart points={points} currency={store.currency} granularity={granularity} />
      <CampaignPerformance store={store} period={period} initialCampaignId={initialCampaignId} />
      <CollectionReturn collections={store.collections} currency={store.currency} period={period} />
      <StoreActivityLog activity={store.activity} currency={store.currency} />
    </div>
  );
}

export function AnalyticsPrototype({
  initialClientId,
  initialStoreId,
  initialCampaignId,
}: {
  initialClientId?: string;
  initialStoreId?: string;
  initialCampaignId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [period, setPeriod] = React.useState<PrototypePeriod>("d7");
  const [cogs, setCogs] = React.useState<Record<string, number>>(() => Object.fromEntries(PERFORMANCE_PROTOTYPE_CLIENTS.flatMap((client) => client.stores.map((store) => [store.id, DEFAULT_COG]))));
  const [syncing, setSyncing] = React.useState(false);
  const [syncedAt, setSyncedAt] = React.useState<string | null>(null);
  const syncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientLabelId = React.useId();

  React.useEffect(() => () => { if (syncTimer.current) clearTimeout(syncTimer.current); }, []);

  const client = PERFORMANCE_PROTOTYPE_CLIENTS.find((entry) => entry.id === initialClientId) ?? null;
  const clientId = client?.id ?? null;
  const storeId = client?.stores.some((entry) => entry.id === initialStoreId) ? initialStoreId! : ALL_STORES;
  const store = client && storeId !== ALL_STORES ? client.stores.find((entry) => entry.id === storeId) ?? null : null;
  const periodLabel = PROTOTYPE_PERIODS.find((entry) => entry.value === period)?.label ?? period;

  function changeClient(nextClientId: string | null) {
    router.push(nextClientId ? `${pathname}?client=${encodeURIComponent(nextClientId)}` : pathname);
  }

  function selectStore(nextClientId: string, nextStoreId: string) {
    const query = new URLSearchParams({ client: nextClientId, store: nextStoreId });
    router.push(`${pathname}?${query}`);
  }

  function sync() {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncing(true);
    syncTimer.current = setTimeout(() => {
      setSyncing(false);
      setSyncedAt(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
      syncTimer.current = null;
    }, 700);
  }

  return (
    <PageContainer
      title="Analytics"
      description={<>{client ? "Store-first performance" : "All-client overview"} · {periodLabel}{syncedAt && <span className="ml-1 text-[var(--success-green)]" role="status" aria-live="polite">· mock data synced at {syncedAt}</span>}</>}
      actions={
        <>
          <Badge variant="neutral" className="hidden sm:inline-flex"><Database className="size-3" aria-hidden />Prototype data</Badge>
          <Select value={period} onValueChange={(value) => setPeriod(value as PrototypePeriod)}>
            <SelectTrigger className="w-[128px]" aria-label="Performance period"><SelectValue /></SelectTrigger>
            <SelectContent>{PROTOTYPE_PERIODS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="button" variant="secondary" size="sm" loading={syncing} onClick={sync}><RefreshCw aria-hidden />Sync</Button>
        </>
      }
    >
      <div className="space-y-4">
        <section className="panel p-4">
          {client && (
            <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-2" onClick={() => changeClient(null)}>
              <ChevronLeft aria-hidden />All clients
            </Button>
          )}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:max-w-[720px]">
              <div className="space-y-1.5">
                <span id={clientLabelId} className="label-caps block">1. Client</span>
                <ClientCombobox value={clientId} onValueChange={changeClient} labelledBy={clientLabelId} />
              </div>
              <div className="space-y-1.5">
                <span className="label-caps block">2. Store</span>
                {client ? (
                  <Select value={storeId} onValueChange={(nextStoreId) => {
                    if (nextStoreId === ALL_STORES) changeClient(client.id);
                    else selectStore(client.id, nextStoreId);
                  }}>
                    <SelectTrigger aria-label="Select store"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_STORES}>All stores</SelectItem>
                      {client.stores.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.domain}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select disabled>
                    <SelectTrigger aria-label="Select a client before selecting a store"><SelectValue placeholder="Select a client" /></SelectTrigger>
                  </Select>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
              {client ? (
                store ? <StoreIcon className="size-3.5 text-[var(--accent-gold)]" aria-hidden /> : <ShoppingBag className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
              ) : (
                <Users className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
              )}
              {client ? (store ? store.domain : `${client.stores.length} stores in this client`) : `${PERFORMANCE_PROTOTYPE_CLIENTS.length} clients`}
            </div>
          </div>
        </section>

        {!client ? (
          <AllClientsSummary onSelectClient={changeClient} onSelectStore={selectStore} />
        ) : store ? (
          <StoreAnalytics
            key={store.id}
            store={store}
            averageCog={cogs[store.id] ?? DEFAULT_COG}
            onAverageCogChange={(value) => setCogs((current) => ({ ...current, [store.id]: value }))}
            period={period}
            initialCampaignId={initialCampaignId}
          />
        ) : (
          <AllStoresSummary client={client} cogs={cogs} period={period} onSelectStore={(nextStoreId) => selectStore(client.id, nextStoreId)} />
        )}
      </div>
    </PageContainer>
  );
}
