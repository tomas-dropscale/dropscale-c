import "server-only";

import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { clientReportingAuthority } from "@/lib/portal/client-rollout";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  AdAccount,
  AdAccountCommissionTerm,
  Client,
  ClientApprovalStatus,
  Profile,
} from "@/lib/supabase/types";

const CLIENT_COLUMNS = "id, full_name, email, approval_status" as const;
const PROFILE_COLUMNS = "id, role" as const;
const ACCOUNT_COLUMNS =
  "id, client_id, store_name, google_ads_customer_id, status, currency, shopify_url, commission_rate, list_commission_rate, revenue_share_enabled" as const;
const TERM_COLUMNS =
  "id, ad_account_id, effective_from, revision, supersedes_id, decision_id, list_rate, reviewed_by, created_at, sealed_at" as const;

type ClientRow = Pick<Client, "id" | "full_name" | "email" | "approval_status">;
type ProfileRow = Pick<Profile, "id" | "role">;
type AccountRow = Pick<
  AdAccount,
  | "id"
  | "client_id"
  | "store_name"
  | "google_ads_customer_id"
  | "status"
  | "currency"
  | "shopify_url"
  | "commission_rate"
  | "list_commission_rate"
  | "revenue_share_enabled"
>;
type CommissionTermRow = AdAccountCommissionTerm;

export type AdminCommissionBillingAccount = {
  id: string;
  kind: "google_ads" | "legacy";
  name: string;
  googleAdsCustomerId: string | null;
  status: AdAccount["status"];
  currency: string;
  commissionRate: number;
  listCommissionRate: number;
  expectedTermId: string | null;
  scheduledListCommissionRate: number | null;
  scheduledEffectiveFrom: string | null;
  revenueShareEnabled: boolean;
};

export type AdminCommissionStore = {
  id: string;
  name: string;
  domain: string | null;
  status: AdAccount["status"];
  currency: string;
  billingAccounts: AdminCommissionBillingAccount[];
};

export type AdminCommissionClient = {
  id: string;
  name: string;
  email: string;
  approvalStatus: ClientApprovalStatus;
  stores: AdminCommissionStore[];
  unallocatedBillingAccounts: AdminCommissionBillingAccount[];
};

function textOrder(left: string, right: string) {
  return left.trim().localeCompare(right.trim(), "en", { sensitivity: "base" });
}

function inconsistent(): never {
  throw new Error("The admin client commission catalogue is inconsistent.");
}

function rate(value: unknown) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    inconsistent();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) inconsistent();
  return parsed;
}

function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) inconsistent();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) inconsistent();
  return value;
}

function lisbonDay() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function projectedShopDomain(source: CanonicalReportingSource): string {
  return source.shopify?.primaryDomain?.trim().toLowerCase() || source.shopify!.domain;
}

function isShopifyAnchor(source: CanonicalReportingSource) {
  return (
    source.shopify !== null &&
    source.group.shopifyAnchorBindingId === source.bindingId &&
    source.group.shopifyAnchorAdAccountId === source.adAccountId
  );
}

function currentTerms(
  rows: CommissionTermRow[],
  account: AccountRow,
): Pick<
  AdminCommissionBillingAccount,
  | "commissionRate"
  | "listCommissionRate"
  | "expectedTermId"
  | "scheduledListCommissionRate"
  | "scheduledEffectiveFrom"
> {
  const terms = rows
    .filter((term) => term.ad_account_id === account.id)
    .sort(
      (left, right) =>
        left.effective_from.localeCompare(right.effective_from) ||
        left.revision - right.revision,
    );

  const today = lisbonDay();
  const seenIds = new Set<string>();
  const revisionsByDay = new Map<string, number>();
  terms.forEach((term, index) => {
    const effectiveFrom = date(term.effective_from);
    const expectedRevision = (revisionsByDay.get(effectiveFrom) ?? 0) + 1;
    if (
      !term.id ||
      seenIds.has(term.id) ||
      !term.decision_id ||
      !term.reviewed_by ||
      !term.created_at ||
      !term.sealed_at ||
      term.revision !== expectedRevision ||
      (index === 0 ? term.supersedes_id !== null : term.supersedes_id !== terms[index - 1]?.id)
    ) {
      inconsistent();
    }
    seenIds.add(term.id);
    revisionsByDay.set(effectiveFrom, expectedRevision);
    rate(term.list_rate);
  });

  const currentListRate = rate(account.list_commission_rate);
  const effectiveRate = rate(account.commission_rate);
  if (effectiveRate > currentListRate) inconsistent();

  // 0061 deliberately has no synthetic backfill: before the first manual
  // decision, the durable historical/default list term is 10% with a null CAS
  // head. Referral terms may already make the effective cache lower.
  if (terms.length === 0) {
    if (currentListRate !== 10) inconsistent();
    return {
      commissionRate: effectiveRate,
      listCommissionRate: currentListRate,
      expectedTermId: null,
      scheduledListCommissionRate: null,
      scheduledEffectiveFrom: null,
    };
  }

  const active = terms.findLast((term) => term.effective_from <= today);
  const latest = terms.at(-1)!;
  if (active ? rate(active.list_rate) !== currentListRate : currentListRate !== 10) {
    inconsistent();
  }

  const scheduled = latest.effective_from > today ? latest : null;
  return {
    commissionRate: effectiveRate,
    listCommissionRate: currentListRate,
    expectedTermId: latest.id,
    scheduledListCommissionRate: scheduled ? rate(scheduled.list_rate) : null,
    scheduledEffectiveFrom: scheduled ? date(scheduled.effective_from) : null,
  };
}

function billingAccount(
  account: AccountRow,
  terms: CommissionTermRow[],
  identity: { kind: AdminCommissionBillingAccount["kind"]; name: string; customerId: string | null },
): AdminCommissionBillingAccount {
  return {
    id: account.id,
    kind: identity.kind,
    name: identity.name.trim() || "Unnamed billing account",
    googleAdsCustomerId: identity.customerId,
    status: account.status,
    currency: account.currency,
    ...currentTerms(terms, account),
    revenueShareEnabled: account.revenue_share_enabled,
  };
}

function legacyStores(accounts: AccountRow[], terms: CommissionTermRow[]): AdminCommissionStore[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.store_name.trim() || "Unnamed store",
    domain:
      typeof account.shopify_url === "string" ? normalizeShopDomain(account.shopify_url) : null,
    status: account.status,
    currency: account.currency,
    billingAccounts: [
      billingAccount(account, terms, {
        kind: "legacy",
        name: account.store_name,
        customerId: account.google_ads_customer_id,
      }),
    ],
  }));
}

function v2Projection(
  clientId: string,
  accounts: AccountRow[],
  terms: CommissionTermRow[],
  sources: CanonicalReportingSource[],
  closedGoogleAccountIds: ReadonlySet<string>,
): Pick<AdminCommissionClient, "stores" | "unallocatedBillingAccounts"> {
  if (sources.length === 0 || sources.some((source) => source.clientId !== clientId)) {
    inconsistent();
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  if (
    accountById.size !== accounts.length ||
    sources.some((source) => !accountById.has(source.adAccountId)) ||
    new Set(sources.map((source) => source.adAccountId)).size !== sources.length
  ) {
    inconsistent();
  }

  const authorizedGoogleAccountIds = new Set(
    sources
      .filter((source) => source.googleAds !== null)
      .map((source) => source.adAccountId),
  );
  // A billable Google account must be represented by a live Google source -
  // unless its meter is closed. A store handover leaves exactly that: the old
  // account keeps its customer id as history while its only remaining source
  // is the Shopify-only replacement (or, after a child handover, no source at
  // all). Its captured end caps every invoice, so there is nothing here left
  // to price; failing the whole catalogue closed over it took down the
  // commercial-terms surface for every client.
  if (
    accounts.some(
      (account) =>
        (account.status === "active" || account.status === "suspended") &&
        account.google_ads_customer_id !== null &&
        !authorizedGoogleAccountIds.has(account.id) &&
        !closedGoogleAccountIds.has(account.id),
    )
  ) {
    inconsistent();
  }

  const anchors = sources.filter(isShopifyAnchor);
  const anchorByBinding = new Map(anchors.map((source) => [source.bindingId, source]));
  if (
    anchorByBinding.size !== anchors.length ||
    sources.some((source) => source.shopify !== null && !isShopifyAnchor(source))
  ) {
    inconsistent();
  }
  for (const source of sources) {
    const anchorBindingId = source.group.shopifyAnchorBindingId;
    if (anchorBindingId === null) {
      if (
        source.shopify !== null ||
        source.googleAds === null ||
        source.group.shopifyAnchorAdAccountId !== null ||
        source.group.id !== source.bindingId
      ) {
        inconsistent();
      }
      continue;
    }
    const anchor = anchorByBinding.get(anchorBindingId);
    if (
      !anchor ||
      source.group.id !== anchor.bindingId ||
      source.group.shopifyAnchorAdAccountId !== anchor.adAccountId
    ) {
      inconsistent();
    }
  }

  const stores = anchors.map((anchor) => {
    const anchorAccount = accountById.get(anchor.adAccountId);
    if (!anchorAccount || !anchor.shopify) inconsistent();
    const grouped = sources.filter(
      (source) => source.group.shopifyAnchorBindingId === anchor.bindingId,
    );
    const physicalBillingAccounts = grouped
      .filter((source) => source.googleAds !== null)
      .map((source) => {
        const account = accountById.get(source.adAccountId);
        if (!account || !source.googleAds) inconsistent();
        return billingAccount(account, terms, {
          kind: "google_ads",
          name: source.googleAds.accountName,
          customerId: source.googleAds.customerId,
        });
      })
      .sort((left, right) => textOrder(left.name, right.name) || textOrder(left.id, right.id));

    return {
      id: anchor.adAccountId,
      name: anchor.shopify.shopifyName,
      domain: projectedShopDomain(anchor),
      status: anchorAccount.status,
      currency: anchorAccount.currency,
      billingAccounts: physicalBillingAccounts,
    };
  });

  const unallocatedBillingAccounts = sources
    .filter((source) => source.group.shopifyAnchorBindingId === null)
    .map((source) => {
      const account = accountById.get(source.adAccountId);
      if (!account || !source.googleAds) inconsistent();
      return billingAccount(account, terms, {
        kind: "google_ads",
        name: source.googleAds.accountName,
        customerId: source.googleAds.customerId,
      });
    })
    .sort((left, right) => textOrder(left.name, right.name) || textOrder(left.id, right.id));

  return { stores, unallocatedBillingAccounts };
}

/** Logical client stores and their exact physical commission-bearing accounts. */
export async function listAdminCommissionClients(): Promise<AdminCommissionClient[]> {
  await requireClientOnboardingAdmin();
  const service = createServiceClient();
  if (!service) throw new Error("The admin client commission catalogue is unavailable.");

  const [clientsResult, profilesResult, accountsResult, termsResult, endsResult] =
    await Promise.all([
      service.from("portal_clients").select(CLIENT_COLUMNS),
      service.from("profiles").select(PROFILE_COLUMNS),
      service.from("ad_accounts").select(ACCOUNT_COLUMNS),
      service.from("ad_account_commission_terms").select(TERM_COLUMNS),
      service.from("ad_account_billing_ends").select("ad_account_id"),
    ]);
  const clients = clientsResult.data;
  const profiles = profilesResult.data;
  const accounts = accountsResult.data;
  const terms = termsResult.data;
  const ends = endsResult.data;
  if (
    clientsResult.error ||
    profilesResult.error ||
    accountsResult.error ||
    termsResult.error ||
    endsResult.error ||
    !Array.isArray(clients) ||
    !Array.isArray(profiles) ||
    !Array.isArray(accounts) ||
    !Array.isArray(terms) ||
    !Array.isArray(ends)
  ) {
    throw new Error("The admin client commission catalogue is unavailable.");
  }
  const closedGoogleAccountIds = new Set(
    (ends as { ad_account_id: string }[]).map((end) => end.ad_account_id),
  );

  const adminIds = new Set(
    (profiles as ProfileRow[])
      .filter((profile) => profile.role === "admin")
      .map((profile) => profile.id),
  );
  const clientById = new Map((clients as ClientRow[]).map((client) => [client.id, client]));
  const accountsByClient = new Map<string, AccountRow[]>();
  for (const account of accounts as AccountRow[]) {
    if (!clientById.has(account.client_id)) inconsistent();
    if (adminIds.has(account.client_id)) continue;
    const owned = accountsByClient.get(account.client_id) ?? [];
    owned.push(account);
    accountsByClient.set(account.client_id, owned);
  }

  const ownedClients = (clients as ClientRow[]).filter(
    (client) => !adminIds.has(client.id) && accountsByClient.has(client.id),
  );
  const authorities = new Map(
    await Promise.all(
      ownedClients.map(
        async (client) => [client.id, await clientReportingAuthority(client.id)] as const,
      ),
    ),
  );
  if ([...authorities.values()].some((authority) => authority === "unavailable")) {
    throw new Error("The admin client commission catalogue is unavailable.");
  }

  const v2ClientIds = ownedClients
    .filter((client) => authorities.get(client.id) === "v2")
    .map((client) => client.id);
  const v2Sources = v2ClientIds.length
    ? await resolveReportingSources({
        service,
        clientIds: v2ClientIds,
        includeShopifyCredentials: false,
      })
    : [];

  return ownedClients
    .map((client) => {
      const owned = accountsByClient.get(client.id) ?? [];
      const projection =
        authorities.get(client.id) === "v2"
          ? v2Projection(
              client.id,
              owned,
              terms as CommissionTermRow[],
              v2Sources.filter((source) => source.clientId === client.id),
              closedGoogleAccountIds,
            )
          : {
              stores: legacyStores(owned, terms as CommissionTermRow[]),
              unallocatedBillingAccounts: [],
            };
      return {
        id: client.id,
        name: client.full_name.trim() || client.email,
        email: client.email,
        approvalStatus: client.approval_status,
        stores: projection.stores.sort(
          (left, right) => textOrder(left.name, right.name) || textOrder(left.id, right.id),
        ),
        unallocatedBillingAccounts: projection.unallocatedBillingAccounts,
      };
    })
    .sort(
      (left, right) =>
        textOrder(left.name, right.name) ||
        textOrder(left.email, right.email) ||
        textOrder(left.id, right.id),
    );
}
