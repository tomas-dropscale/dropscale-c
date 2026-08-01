"use client";

import * as React from "react";
import {
  BadgeDollarSign,
  Coins,
  Crosshair,
  Eye,
  HandCoins,
  LayoutDashboard,
  MousePointerClick,
  Percent,
  Target,
  TrendingUp,
  Unplug,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { FormAlert } from "@/components/auth/auth-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NextRefresh } from "@/components/admin/next-refresh";
import { DailyPerformanceChart } from "@/components/portal/daily-performance-chart";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { compact, integer, money, multiplier, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AdminClientOverview, AdminStoreOverview } from "@/lib/admin/client-overview";
import type { RangeSelection } from "@/lib/portal/range";

/**
 * The agency's view of ONE client, in a popup over the campaigns page.
 *
 * Two levels, because that is how the agency actually reads a client: the
 * whole book of business at the top, then each store's ad spend on its own.
 * It shows the client's own numbers PLUS the agency's take, which is the half
 * a client is never shown.
 *
 * GOOGLE ONLY. Every revenue figure is narrowed to orders Instagram and
 * Facebook did not refer — see lib/admin/client-overview.ts. The blended totals
 * are not available on the props at all, so nothing here can print them by
 * mistake; the labelling below exists so a reader knows which question these
 * numbers answer before comparing them against a Shopify admin screen.
 *
 * Fetched on open, not with the page: the campaigns list can hold dozens of
 * clients, and loading every one of these up front would cost a table scan per
 * client to render something nobody asked to see yet.
 */

/**
 * Money that may not exist yet.
 *
 * Attribution is computed per day (0019); a window predating that has no
 * honest Google-only figure. A dash says so. Falling back to total revenue
 * would put Meta's sales back on the page under a Google heading — the precise
 * thing this report must not do.
 */
function maybeMoney(value: number | null, currency: string): string {
  return value === null ? "—" : money(value, currency);
}

function Stat({
  label,
  icon: Icon,
  value,
  hint,
  accent,
  hero,
}: {
  label: string;
  icon: typeof Wallet;
  value: string;
  hint?: string;
  /** Gold. The agency's own money, and the client's revenue headline. */
  accent?: boolean;
  /** The one figure the report opens on — bigger, and spans two columns. */
  hero?: boolean;
}) {
  const gold = accent || hero;

  return (
    <div
      className={cn(
        "rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3",
        gold && "border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)]",
        hero && "sm:col-span-2 sm:p-4",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="label-caps">{label}</p>
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            gold ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
          )}
          aria-hidden
        />
      </div>
      <p
        className={cn(
          "mt-1 truncate font-semibold tabular-nums",
          hero ? "text-[26px]" : "text-[18px]",
          gold ? "text-[var(--accent-gold-strong)]" : "text-[var(--text-primary)]",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

/** One store's ad-spend dashboard. */
function StoreCard({ store }: { store: AdminStoreOverview }) {
  const currency = store.currency;

  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2.5">
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: store.colorDot }}
          aria-hidden
        />
        <h4 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
          {store.storeName}
        </h4>
        {!store.connected && (
          <Badge variant="warning">
            <Unplug className="size-3" aria-hidden />
            Not connected
          </Badge>
        )}
        <Badge variant="neutral">{store.commissionRate}% ad spend</Badge>
        {store.revShareEnabled && <Badge variant="success">+ rev share</Badge>}
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {/* What this shop made THROUGH US, first and in gold — the question the
            per-store section exists to answer. Meta-referred orders are out:
            they are revenue the client earned without our ads. */}
        <Stat
          hero
          label="Google revenue"
          icon={BadgeDollarSign}
          value={maybeMoney(store.googleRevenue, currency)}
          hint={
            store.googleOrders === null
              ? "awaiting attribution sync"
              : `${integer(store.googleOrders)} orders · excl. Meta referrals`
          }
        />
        <Stat label="Ad spend" icon={Wallet} value={money(store.adSpend, currency)} />
        <Stat label="Impressions" icon={Eye} value={compact(store.impressions)} />
        <Stat label="Clicks" icon={MousePointerClick} value={integer(store.clicks)} />
        <Stat label="CTR" icon={Percent} value={percent(store.ctr)} />
        <Stat label="CPC" icon={Coins} value={money(store.cpc, currency)} />
        {/* Orders minus the ones Instagram/Facebook referred (0019), with
            Google's own count as the hint — the same treatment ROAS gets below
            and for the same reason. */}
        <Stat
          label="Conversions"
          icon={Target}
          value={store.googleOrders === null ? "—" : integer(store.googleOrders)}
          hint={`${integer(store.conversions)} tracked by Google`}
        />
        <Stat
          label="Cost / conv."
          icon={Crosshair}
          value={money(
            store.googleOrders === null ? store.costPerConversion : store.costPerGoogleOrder,
            currency,
          )}
        />
        <Stat
          label="ROAS"
          icon={TrendingUp}
          value={multiplier(store.roas)}
          hint={`${multiplier(store.trackedRoas)} tracked by Google`}
        />
        <Stat
          label="We bill"
          icon={HandCoins}
          value={money(store.commission + store.revShare, currency)}
          hint={
            store.revShare > 0
              ? `${money(store.commission, currency)} fee + ${money(store.revShare, currency)} rev share`
              : `${store.commissionRate}% of ad spend`
          }
          accent
        />
      </div>

    </section>
  );
}

function Body({ data }: { data: AdminClientOverview }) {
  const currency = data.currency;
  const t = data.totals;

  return (
    <div className="space-y-5">
      {/* ---- the client's business ---- */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="label-caps">Client — all stores</h3>
          {/* Stated once, plainly, at the top. Without it an admin reading
              "Revenue" here against the client's Shopify admin sees a shortfall
              and assumes the report is broken, when the gap IS the point. */}
          <Badge variant="neutral">Google only · excludes Meta referrals</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {/* Revenue leads, in gold and at double width. It is the number the
              conversation starts from — everything else on this row explains
              what it cost to get there or what is left of it. */}
          <Stat
            hero
            label="Google revenue"
            icon={BadgeDollarSign}
            value={maybeMoney(t.googleRevenue, currency)}
            hint={
              t.googleOrders === null
                ? "awaiting attribution sync"
                : `${integer(t.googleOrders)} orders · ${money(t.aov, currency)} avg`
            }
          />
          <Stat
            label="Ad spend"
            icon={Wallet}
            value={money(t.adSpend, currency)}
            hint={`${compact(t.impressions)} impressions`}
          />
          {/* The real return first. Google's own tracked figure sits
              underneath, because a 0.00x there is the tell that their
              conversion tag is off — not that the ads failed. */}
          <Stat
            label="ROAS"
            icon={TrendingUp}
            value={multiplier(t.roas)}
            hint={`${multiplier(t.trackedRoas)} tracked by Google`}
          />
          <Stat
            label="Margin"
            icon={Percent}
            value={t.margin === null ? "—" : percent(t.margin)}
            hint="costs apportioned · after our cut"
          />
          {/* AOV moved into the revenue hint — it is a property of revenue,
              not a figure that earns its own card next to it. */}
          <Stat
            label="Their profit"
            icon={Coins}
            value={maybeMoney(t.netProfitAfterFee, currency)}
            hint="costs apportioned · after our cut"
          />
        </div>
        {/* COGS, payment fees and shipping are recorded per DAY, not per order,
            so the Google slice of them can only be estimated by revenue share.
            Saying so is cheaper than having someone discover it later. */}
        <p className="text-[11px] text-[var(--text-muted)]">
          Profit and margin apportion COGS, payment fees and shipping by revenue
          share — Shopify does not record them per referrer.
        </p>
      </section>

      {/* ---- what the agency earns ---- */}
      <section className="space-y-2">
        <h3 className="label-caps">Agency</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat
            label="Ad-spend fee"
            icon={HandCoins}
            value={money(t.commission, currency)}
            accent
          />
          <Stat
            label="Revenue share"
            icon={HandCoins}
            value={money(t.revShare, currency)}
            accent
          />
          <Stat
            label="Total billed"
            icon={HandCoins}
            value={money(t.agencyRevenue, currency)}
            hint={t.adSpend > 0 ? `${percent(t.agencyRevenue / t.adSpend)} of ad spend` : undefined}
            accent
          />
        </div>
      </section>

      {data.days.length > 0 && <DailyPerformanceChart days={data.days} currency={currency} />}

      {/* ---- per-store ad spend ---- */}
      <section className="space-y-2">
        <h3 className="label-caps">
          Stores ({data.stores.length}) — ad spend
        </h3>
        {data.stores.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] px-4 py-8 text-center text-[13px] text-[var(--text-secondary)]">
            This client has no stores yet.
          </p>
        ) : (
          <div className="space-y-3">
            {data.stores.map((store) => (
              <StoreCard key={store.accountId} store={store} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const rangeKey = (range: RangeSelection) =>
  range.key === "custom" ? `custom:${range.from}:${range.to}` : range.key;

export function ClientDashboardDialog({
  clientId,
  clientName,
  clientEmail,
  range: pageRange,
}: {
  clientId: string;
  clientName: string;
  clientEmail: string;
  /** The campaigns page's period — the starting point, not a binding. */
  range: RangeSelection;
}) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<AdminClientOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  /**
   * The popup keeps its OWN period.
   *
   * It opens on whatever the campaigns page is showing, then the picker in the
   * header takes over. Deliberately not the page's URL-backed RangePicker:
   * that one routes, which would re-render the page underneath and throw the
   * dialog away mid-read. Local state, and the numbers reload in place.
   */
  const [range, setRange] = React.useState<RangeSelection>(pageRange);

  // Which window the held data is for, so re-opening or re-picking the same
  // period doesn't refetch, and a different one always does.
  const loadedFor = React.useRef<string | null>(null);

  async function load(next: RangeSelection) {
    if (loadedFor.current === rangeKey(next)) return;

    setLoading(true);
    setError(null);
    setData(null);

    const params = new URLSearchParams({
      clientId,
      range: next.key,
      ...(next.key === "custom" ? { from: next.from, to: next.to } : {}),
    });

    try {
      const res = await fetch(`/api/admin/client-overview?${params}`);
      const body = (await res.json().catch(() => null)) as
        | (AdminClientOverview & { error?: string })
        | null;

      if (!res.ok || !body) {
        setError(body?.error ?? "Could not load this client.");
        return;
      }
      setData(body);
      loadedFor.current = rangeKey(next);
    } catch {
      setError("Could not load this client.");
    } finally {
      setLoading(false);
    }
  }

  // Loaded from the click, not an effect: opening IS the event that needs the
  // data, and an effect would re-run on every unrelated re-render.
  function open_() {
    setOpen(true);
    if (!loading) void load(range);
  }

  function applyRange(next: RangeSelection) {
    setRange(next);
    void load(next);
  }

  return (
    <>
      <button
        type="button"
        // This button lives inside a <summary>. Without both of these a click
        // would toggle the <details> shut underneath the dialog it just opened.
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void open_();
        }}
        className="transition-smooth inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent-gold)]/40 hover:text-[var(--accent-gold-strong)]"
        aria-label={`Open ${clientName}'s report`}
      >
        <LayoutDashboard className="size-3.5" aria-hidden />
        Report
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* Wide and scrollable: this is a dashboard, not a form. */}
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-[1100px] overflow-y-auto">
          <DialogHeader>
            {/* pr-16 clears the dialog's own close button, which is absolutely
                positioned in the same corner as the picker. */}
            <div className="flex flex-wrap items-start justify-between gap-3 pr-16">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2.5">
                  <Avatar name={clientName} seed={clientId} size="sm" />
                  <span className="min-w-0 truncate">{clientName}</span>
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {clientEmail}
                  {data && ` · ${data.range.from} → ${data.range.to}`}
                  {data?.updatedAt && ` · synced ${new Date(data.updatedAt).toLocaleString()}`}
                </DialogDescription>

                {/* Says when the figures below are next rebuilt, so an admin
                    reading a number knows whether it is worth waiting for the
                    next run rather than guessing at how stale it is. */}
                <NextRefresh className="mt-2" />
              </div>

              {/* The period belongs to the dashboard, not to the page behind
                  it. `align="start"` so the panel opens inward and doesn't
                  spill past the dialog's right edge. */}
              <div className="shrink-0">
                <DateRangePicker value={range} onApply={applyRange} align="start" />
              </div>
            </div>
          </DialogHeader>

          {error && <FormAlert>{error}</FormAlert>}

          {loading && (
            <div className="space-y-3" aria-busy>
              {/* Skeleton rather than a spinner: the layout below is tall, and
                  a centred spinner makes the dialog jump when data lands. */}
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="h-24 animate-pulse rounded-[var(--radius-card)] bg-[var(--bg-panel-hover)]"
                />
              ))}
            </div>
          )}

          {data && !loading && <Body data={data} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
