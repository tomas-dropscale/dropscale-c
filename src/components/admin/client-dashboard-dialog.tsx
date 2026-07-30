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
  ShoppingBag,
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
 * It shows what the client's own dashboard shows PLUS the agency's take,
 * which is the half a client is never shown.
 *
 * Fetched on open, not with the page: the campaigns list can hold dozens of
 * clients, and loading every one of these up front would cost a table scan per
 * client to render something nobody asked to see yet.
 */

function Stat({
  label,
  icon: Icon,
  value,
  hint,
  accent,
}: {
  label: string;
  icon: typeof Wallet;
  value: string;
  hint?: string;
  /** Gold — reserved for the agency's own money. */
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3",
        accent && "border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="label-caps">{label}</p>
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            accent ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
          )}
          aria-hidden
        />
      </div>
      <p
        className={cn(
          "mt-1 truncate text-[18px] font-semibold tabular-nums",
          accent ? "text-[var(--accent-gold-strong)]" : "text-[var(--text-primary)]",
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
        <Stat label="Ad spend" icon={Wallet} value={money(store.adSpend, currency)} />
        <Stat label="Impressions" icon={Eye} value={compact(store.impressions)} />
        <Stat label="Clicks" icon={MousePointerClick} value={integer(store.clicks)} />
        <Stat label="CTR" icon={Percent} value={percent(store.ctr)} />
        <Stat label="CPC" icon={Coins} value={money(store.cpc, currency)} />
        {/* Store conversions — orders minus the ones Instagram/Facebook
            referred (0019) — with Google's own count as the hint, the same
            treatment ROAS gets below and for the same reason. */}
        <Stat
          label="Conversions"
          icon={Target}
          value={integer(store.storeConversions ?? store.conversions)}
          hint={
            store.storeConversions != null
              ? `${integer(store.conversions)} attributed by Google · excl. Meta referrals`
              : undefined
          }
        />
        <Stat
          label="Cost / conv."
          icon={Crosshair}
          value={money(
            store.storeConversions != null
              ? store.costPerStoreConversion
              : store.costPerConversion,
            currency,
          )}
        />
        <Stat
          label="ROAS"
          icon={TrendingUp}
          value={multiplier(store.roas)}
          hint={`${multiplier(store.googleRoas)} attributed by Google`}
        />
        <Stat
          label="Conv. value"
          icon={BadgeDollarSign}
          value={money(store.conversionValue, currency)}
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

      {/* Store-side reality check: the shop's own numbers next to the ad spend
          above, so a store that spends well but sells badly is visible here. */}
      <p className="mt-3 border-t border-[var(--border-subtle)] pt-2.5 text-[11.5px] text-[var(--text-muted)]">
        Store: {money(store.netRevenue, currency)} net revenue · {integer(store.orders)} orders
      </p>
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
        <h3 className="label-caps">Client — all stores</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Net revenue"
            icon={BadgeDollarSign}
            value={money(t.netRevenue, currency)}
            hint={`${integer(t.orders)} orders`}
          />
          <Stat
            label="Ad spend"
            icon={Wallet}
            value={money(t.adSpend, currency)}
            hint={`${compact(t.impressions)} impressions`}
          />
          {/* The client's own figure first — this popup exists to see what
              they see. Google's attributed one sits underneath, because a
              0.00x there is the tell that their conversion tracking is off. */}
          <Stat
            label="ROAS"
            icon={TrendingUp}
            value={multiplier(t.mer)}
            hint={`${multiplier(t.roas)} attributed by Google`}
          />
          {/* Was MER, which is the same division as the ROAS beside it now —
              two cards for one number. Margin is the other half of the story:
              a 4x return still loses money if the products cost too much. */}
          <Stat
            label="Margin"
            icon={Percent}
            value={percent(t.netRevenue > 0 ? t.netProfitAfterFee / t.netRevenue : 0)}
            hint="after COGS, fees and our cut"
          />
          <Stat label="AOV" icon={ShoppingBag} value={money(t.aov, currency)} />
          <Stat
            label="Their profit"
            icon={Coins}
            value={money(t.netProfitAfterFee, currency)}
            hint="after COGS, fees and our cut"
          />
        </div>
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
        aria-label={`Open ${clientName}'s dashboard`}
      >
        <LayoutDashboard className="size-3.5" aria-hidden />
        Dashboard
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
