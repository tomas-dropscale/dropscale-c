import type { Metadata } from "next";
import Link from "next/link";
import { BadgePercent, ChevronRight, CircleDollarSign, Store, UserPlus } from "lucide-react";

import { CommissionRate } from "@/components/admin/commission-rate";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  listAdminCommissionClients,
  type AdminCommissionBillingAccount,
} from "@/lib/admin/client-commissions";
import type { ClientApprovalStatus } from "@/lib/supabase/types";

export const metadata: Metadata = { title: "Clients" };

function approvalBadge(status: ClientApprovalStatus) {
  if (status === "approved") return <Badge variant="success">Approved</Badge>;
  if (status === "pending") return <Badge variant="warning">Pending</Badge>;
  return <Badge variant="danger">Rejected</Badge>;
}

function accountStatus(status: "active" | "suspended" | "pending") {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status === "suspended") return <Badge variant="warning">Suspended</Badge>;
  return <Badge variant="neutral">Pending</Badge>;
}

function BillingAccountRow({
  account,
  nested = false,
}: {
  account: AdminCommissionBillingAccount;
  nested?: boolean;
}) {
  return (
    <div className="grid min-h-16 gap-3 px-4 py-3 md:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)] lg:items-center">
      <div className={`flex min-w-0 items-start gap-3 ${nested ? "pl-7" : ""}`}>
        <CircleDollarSign
          className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="label-caps mb-1">
            {account.kind === "google_ads" ? "Google billing account" : "Legacy billing account"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
              {account.name}
            </p>
            {accountStatus(account.status)}
            <Badge variant="neutral">{account.currency}</Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {account.googleAdsCustomerId ?? account.id}
          </p>
        </div>
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
    </div>
  );
}

/** Logical stores with exact physical billing-account terms; referrals stay separate. */
export default async function AdminClientsPage() {
  const clients = await listAdminCommissionClients();

  return (
    <PageContainer
      title="Clients"
      description="Review each logical store and maintain the manual term of every physical billing account."
      actions={
        <>
          <Button asChild size="sm">
            <Link href="/admin/client-onboarding">
              <UserPlus aria-hidden />
              Onboarding
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/referrals">
              <BadgePercent aria-hidden />
              Referrals
            </Link>
          </Button>
        </>
      }
    >
      <section className="panel mb-5 grid gap-4 p-4 text-[12px] leading-relaxed text-[var(--text-secondary)] sm:grid-cols-3 md:p-5">
        <div>
          <p className="label-caps mb-1">Manual base</p>
          <p>
            A physical billing account starts at <strong>10%</strong>. Every change is an audited
            term effective on a Monday.
          </p>
        </div>
        <div>
          <p className="label-caps mb-1">Effective rate</p>
          <p>The current list rate and any sealed referral discount remain visible separately.</p>
        </div>
        <div>
          <p className="label-caps mb-1">Logical stores</p>
          <p>
            V2 Google children stay inside their Shopify store; unmapped Google stays separate.
          </p>
        </div>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="client-commission-heading">
        <header className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3 md:px-5">
          <div>
            <h2
              id="client-commission-heading"
              className="text-[15px] font-semibold text-[var(--text-primary)]"
            >
              Commission by client
            </h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              Edit one exact billing account at a time. Mixed store rates stay explicit.
            </p>
          </div>
          <Badge variant="neutral">
            {clients.length} {clients.length === 1 ? "client" : "clients"}
          </Badge>
        </header>

        {clients.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              No client stores yet
            </p>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">
              Complete onboarding before setting a billing-account commission.
            </p>
          </div>
        ) : (
          clients.map((client) => {
            const billingAccounts = [
              ...client.stores.flatMap((store) => store.billingAccounts),
              ...client.unallocatedBillingAccounts,
            ];
            const listRates = [
              ...new Set(billingAccounts.map((account) => account.listCommissionRate)),
            ];
            return (
              <details
                key={client.id}
                className="group/client border-t border-[var(--border-subtle)] first:border-t-0"
              >
                <summary className="transition-smooth flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3.5 hover:bg-[var(--bg-panel-hover)] md:px-5 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-4 shrink-0 text-[var(--text-muted)] transition-transform group-open/client:rotate-90"
                    aria-hidden
                  />
                  <Avatar name={client.name} seed={client.id} size="sm" />
                  <span className="min-w-44 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                      {client.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-muted)]">
                      {client.email}
                    </span>
                  </span>
                  {approvalBadge(client.approvalStatus)}
                  <Badge variant="neutral">
                    {client.stores.length} {client.stores.length === 1 ? "store" : "stores"}
                  </Badge>
                  <Badge variant="neutral">
                    {billingAccounts.length} billing{" "}
                    {billingAccounts.length === 1 ? "account" : "accounts"}
                  </Badge>
                  {listRates.length > 0 && (
                    <Badge variant={listRates.length === 1 ? "gold" : "warning"}>
                      {listRates.length === 1 ? `${listRates[0]}% current list` : "Mixed list rates"}
                    </Badge>
                  )}
                </summary>

                <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                  {client.stores.map((store) => (
                    <section key={store.id} aria-label={store.name}>
                      <header className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 md:px-5">
                        <Store
                          className="size-4 shrink-0 text-[var(--accent-gold)]"
                          aria-hidden
                        />
                        <div className="min-w-44 flex-1">
                          <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                            {store.name}
                          </p>
                          <p className="mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">
                            {store.domain ?? "No Shopify domain"}
                          </p>
                        </div>
                        {accountStatus(store.status)}
                        <Badge variant="neutral">{store.currency}</Badge>
                        <Badge variant="neutral">
                          {store.billingAccounts.length} billing{" "}
                          {store.billingAccounts.length === 1 ? "account" : "accounts"}
                        </Badge>
                      </header>

                      <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
                        {store.billingAccounts.length === 0 ? (
                          <p className="px-4 py-4 text-[12px] text-[var(--text-muted)] md:px-5">
                            No Google billing account is assigned to this store.
                          </p>
                        ) : (
                          <div className="divide-y divide-[var(--border-subtle)]">
                            {store.billingAccounts.map((account) => (
                              <BillingAccountRow key={account.id} account={account} nested />
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  ))}
                  {client.unallocatedBillingAccounts.length > 0 && (
                    <section aria-label="Unallocated Google billing">
                      <header className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 md:px-5">
                        <CircleDollarSign
                          className="size-4 shrink-0 text-[var(--warning-orange)]"
                          aria-hidden
                        />
                        <div className="min-w-44 flex-1">
                          <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                            Unallocated Google billing
                          </p>
                          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                            Authorized Google sources without a Shopify store mapping. Not counted as
                            stores.
                          </p>
                        </div>
                        <Badge variant="warning">
                          {client.unallocatedBillingAccounts.length}{" "}
                          {client.unallocatedBillingAccounts.length === 1 ? "account" : "accounts"}
                        </Badge>
                      </header>
                      <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
                        {client.unallocatedBillingAccounts.map((account) => (
                          <BillingAccountRow key={account.id} account={account} />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </details>
            );
          })
        )}
      </section>
    </PageContainer>
  );
}
