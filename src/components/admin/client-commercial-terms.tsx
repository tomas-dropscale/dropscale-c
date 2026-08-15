"use client";

import { ChevronRight, CircleDollarSign, Store } from "lucide-react";

import { CommissionRate } from "@/components/admin/commission-rate";
import { Badge } from "@/components/ui/badge";
import type {
  AdminCommissionBillingAccount,
  AdminCommissionClient,
} from "@/lib/admin/client-commissions";

function AccountTerm({ account }: { account: AdminCommissionBillingAccount }) {
  return (
    <li className="grid gap-3 border-t border-[var(--border-subtle)] px-3 py-3 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)] lg:items-center">
      <div className="min-w-0 pl-6">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {account.name}
          </p>
          <Badge variant={account.status === "active" ? "success" : "neutral"}>
            {account.status}
          </Badge>
          <Badge variant="neutral">{account.currency}</Badge>
        </div>
        <p className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-muted)]">
          {account.googleAdsCustomerId ?? account.id}
        </p>
      </div>
      <div className="min-w-0 lg:justify-self-end">
        <CommissionRate
          accountId={account.id}
          rate={account.commissionRate}
          listRate={account.listCommissionRate}
          expectedTermId={account.expectedTermId}
          scheduledListRate={account.scheduledListCommissionRate}
          scheduledEffectiveFrom={account.scheduledEffectiveFrom}
          revenueShareEnabled={account.revenueShareEnabled}
        />
      </div>
    </li>
  );
}

/** Compact, secondary commercial controls for one existing client. */
export function ClientCommercialTerms({ client }: { client: AdminCommissionClient | null }) {
  if (!client) return null;

  const accountCount =
    client.stores.reduce((total, store) => total + store.billingAccounts.length, 0) +
    client.unallocatedBillingAccounts.length;

  return (
    <details className="group/terms mt-3 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <summary className="transition-smooth flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-[var(--bg-panel-hover)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 text-[var(--text-muted)] transition-transform group-open/terms:rotate-90"
          aria-hidden
        />
        <CircleDollarSign className="size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[11.5px] font-medium text-[var(--text-primary)]">
            Commercial terms
          </span>
          <span className="mt-0.5 block text-[10.5px] text-[var(--text-muted)]">
            Manual base 10% · current, effective and scheduled rates
          </span>
        </span>
        <Badge variant="neutral">
          {accountCount} {accountCount === 1 ? "billing account" : "billing accounts"}
        </Badge>
      </summary>

      <div className="border-t border-[var(--border-subtle)]">
        {client.stores.map((store) => (
          <section
            key={store.id}
            className="border-t border-[var(--border-subtle)] first:border-t-0"
            aria-label={`${store.name} commercial terms`}
          >
            <header className="flex min-h-11 items-center gap-2 px-3 py-2.5">
              <Store className="size-3.5 shrink-0 text-[var(--accent-gold-strong)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                  {store.name}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-secondary)]">
                  {store.domain ?? "No Shopify domain"}
                </span>
              </span>
            </header>
            {store.billingAccounts.length > 0 ? (
              <ul className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
                {store.billingAccounts.map((account) => (
                  <AccountTerm key={account.id} account={account} />
                ))}
              </ul>
            ) : (
              <p className="border-t border-[var(--border-subtle)] px-3 py-3 pl-9 text-[11px] text-[var(--text-muted)]">
                No Google billing account is assigned to this store.
              </p>
            )}
          </section>
        ))}

        {client.unallocatedBillingAccounts.length > 0 && (
          <section
            className="border-t border-[var(--border-subtle)]"
            aria-label="Unallocated Google billing commercial terms"
          >
            <header className="flex min-h-11 items-center gap-2 px-3 py-2.5">
              <CircleDollarSign
                className="size-3.5 shrink-0 text-[var(--warning-orange)]"
                aria-hidden
              />
              <span className="text-[12px] font-medium text-[var(--text-primary)]">
                Unallocated Google billing
              </span>
            </header>
            <ul className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
              {client.unallocatedBillingAccounts.map((account) => (
                <AccountTerm key={account.id} account={account} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}
