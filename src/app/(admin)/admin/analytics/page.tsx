import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Search, Users } from "lucide-react";

import { AnalyticsView } from "@/components/admin/analytics-view";
import { RangePicker } from "@/components/portal/range-picker";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import {
  listAdminAnalyticsClients,
  type AdminAnalyticsClient,
} from "@/lib/admin/analytics";
import { listCampaignActionActivity } from "@/lib/admin/campaign-actions";
import { fetchClientOverview } from "@/lib/admin/client-overview";
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

function clientHref(clientId: string, range: RangeSelection): string {
  const params = new URLSearchParams({
    client: clientId,
    range: range.key,
    from: range.from,
    to: range.to,
  });
  return `/admin/analytics?${params.toString()}`;
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
      description={`Choose a client to review its real store performance · ${range.from} → ${range.to}`}
      actions={<RangePicker current={range} />}
    >
      <div className="space-y-4">
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
                  Clients
                </h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  No client is selected by default. Only approved clients with reporting evidence appear here.
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
                    href={clientHref(client.id, range)}
                    className="transition-smooth flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/40 sm:px-5"
                  >
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

  const overview = await fetchClientOverview(selectedClient.id, range);
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
  const activityAccountIds = selectedStore
    ? selectedStore.activityAccountIds
    : overview.activityAccountIds;
  const activity = await listCampaignActionActivity(
    selectedClient.id,
    activityAccountIds,
  );

  return (
    <AnalyticsView
      overview={overview}
      selectedStoreId={requestedStoreId}
      activity={activity.history}
      activityTruncated={activity.truncated}
      range={range}
    />
  );
}
