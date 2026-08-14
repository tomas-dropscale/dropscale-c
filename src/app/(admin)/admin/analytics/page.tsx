import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Search, Store, Users } from "lucide-react";

import {
  AnalyticsScopeSelector,
  AnalyticsView,
} from "@/components/admin/analytics-view";
import { RangePicker } from "@/components/portal/range-picker";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import {
  listAdminAnalyticsClients,
  type AdminAnalyticsClient,
} from "@/lib/admin/analytics";
import {
  analyticsClientHref,
  analyticsStoreHref,
} from "@/lib/admin/analytics-view";
import { fetchClientOverview } from "@/lib/admin/client-overview";
import {
  ensureAdminAnalyticsRollupCoverage,
  fetchAdminStoreAnalytics,
  type AdminAnalyticsFamily,
} from "@/lib/admin/store-analytics";
import { getServerDictionary } from "@/lib/i18n/server";
import { parseRange, type RangeSelection } from "@/lib/portal/range";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.analytics.title };
}

type AnalyticsSearchParams = {
  client?: string | string[];
  store?: string | string[];
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
  q?: string | string[];
};

function singleParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ClientChooser({
  clients,
  range,
  query,
  error,
}: {
  clients: AdminAnalyticsClient[];
  range: RangeSelection;
  query: string;
  error?: string;
}) {
  const needle = query.toLowerCase();
  const visibleClients = needle
    ? clients.filter((client) =>
        `${client.name}\n${client.email}`.toLowerCase().includes(needle),
      )
    : clients;

  return (
    <PageContainer
      title="Analytics"
      description={`All-client overview · ${range.from} → ${range.to}`}
      actions={<RangePicker current={range} />}
    >
      <div className="space-y-4">
        <AnalyticsScopeSelector clients={clients} range={range} />

        {error && (
          <p
            role="alert"
            className="panel border-[var(--warning-orange)]/25 px-4 py-3 text-sm text-[var(--warning-orange)]"
          >
            {error}
          </p>
        )}

        <section className="panel overflow-hidden" aria-labelledby="analytics-clients-title">
          <header className="border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--accent-gold)]">
                <Users className="size-4" aria-hidden />
              </span>
              <div>
                <h2
                  id="analytics-clients-title"
                  className="text-sm font-semibold text-[var(--text-primary)]"
                >
                  All clients
                </h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Choose a client or open one of its Shopify stores.
                </p>
              </div>
            </div>

            <form
              action="/admin/analytics"
              method="get"
              role="search"
              className="mt-4 flex flex-col gap-2 sm:flex-row"
            >
              <input type="hidden" name="range" value={range.key} />
              <input type="hidden" name="from" value={range.from} />
              <input type="hidden" name="to" value={range.to} />
              <label htmlFor="analytics-client-search" className="sr-only">
                Search clients by name or email
              </label>
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                  aria-hidden
                />
                <input
                  id="analytics-client-search"
                  type="search"
                  name="q"
                  defaultValue={query}
                  autoComplete="off"
                  placeholder="Search client name or email…"
                  className="transition-smooth h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] pr-3 pl-9 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] hover:border-[var(--border-strong)] focus-visible:border-[var(--accent-gold)]/50 focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15"
                />
              </div>
              <button
                type="submit"
                className="transition-smooth inline-flex h-10 items-center justify-center rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 text-sm font-medium text-[var(--text-primary)] outline-none hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
              >
                Search
              </button>
            </form>
          </header>

          {visibleClients.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-[var(--text-muted)]">
              {clients.length === 0
                ? "No approved clients have reporting evidence yet."
                : `No clients match “${query}”.`}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {visibleClients.map((client) => (
                <li key={client.id}>
                  <Link
                    href={analyticsClientHref(client.id, range)}
                    className="transition-smooth flex min-h-12 items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/40 sm:px-5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
                      <Users className="size-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {client.name}
                      </p>
                      <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                        {client.email}
                      </p>
                    </div>
                    <Badge variant="neutral">
                      {client.storeCount} {client.storeCount === 1 ? "store" : "stores"}
                    </Badge>
                    <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  </Link>

                  {client.stores.length > 0 && (
                    <ul className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                      {client.stores.map((store) => (
                        <li key={store.id}>
                          <Link
                            href={analyticsStoreHref(client.id, store.id, range)}
                            aria-label={`Open ${store.domain} for ${client.name}`}
                            className="transition-smooth flex min-h-11 items-center gap-3 border-t border-[var(--border-subtle)] px-4 py-2 first:border-t-0 hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/40 sm:px-5 sm:pl-16"
                          >
                            <Store className="size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                                {store.domain}
                              </span>
                              <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">
                                {store.name}
                              </span>
                            </span>
                            <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  const params = await searchParams;
  const range = parseRange(params);
  // This is deliberately first: it reauthenticates the admin before any
  // service-role or cross-client reporting read can be constructed.
  const clients = await listAdminAnalyticsClients();
  const requestedClientId = singleParam(params.client);
  const selectedClient = clients.find((client) => client.id === requestedClientId);
  const query = singleParam(params.q) ?? "";

  if (!requestedClientId || !selectedClient) {
    return (
      <ClientChooser
        clients={clients}
        range={range}
        query={query}
        error={
          requestedClientId
            ? "That client is not approved or has no reporting evidence. Choose an available client."
            : undefined
        }
      />
    );
  }

  let overview = await fetchClientOverview(selectedClient.id, range);
  if (!overview || overview.clientId !== selectedClient.id) {
    return (
      <ClientChooser
        clients={clients}
        range={range}
        query={query}
        error="That client’s reporting overview is unavailable. Choose another client."
      />
    );
  }

  const requestedStoreId = singleParam(params.store);
  const selectedStore = requestedStoreId
    ? overview.stores.find((store) => store.accountId === requestedStoreId) ?? null
    : null;
  const storeAnalytics = selectedStore
    ? await fetchAdminStoreAnalytics({
        clientId: selectedClient.id,
        store: selectedStore,
        range,
      })
    : null;
  const rollupCoverage: AdminAnalyticsFamily<unknown> = storeAnalytics
    ? storeAnalytics.rollupCoverage
    : await ensureAdminAnalyticsRollupCoverage({
        clientId: selectedClient.id,
        stores: overview.stores,
        range,
      });

  // The coverage loader materialises any missing days in this exact window.
  // Re-read the rollup afterwards so the KPI cards and the detailed sections
  // are built from the same completed timeframe rather than a pre-refresh
  // snapshot.
  if (rollupCoverage.state === "ready") {
    const refreshedOverview = await fetchClientOverview(selectedClient.id, range);
    if (!refreshedOverview || refreshedOverview.clientId !== selectedClient.id) {
      return (
        <ClientChooser
          clients={clients}
          range={range}
          query={query}
          error="That client’s refreshed reporting overview is unavailable. Choose another client."
        />
      );
    }
    overview = refreshedOverview;
    if (
      selectedStore &&
      !overview.stores.some((store) => store.accountId === selectedStore.accountId)
    ) {
      return (
        <ClientChooser
          clients={clients}
          range={range}
          query={query}
          error="That store’s reporting topology changed during refresh. Choose the store again."
        />
      );
    }
  }

  return (
    <AnalyticsView
      clients={clients}
      overview={overview}
      selectedStoreId={requestedStoreId}
      storeAnalytics={storeAnalytics}
      rollupCoverage={rollupCoverage}
      range={range}
    />
  );
}
