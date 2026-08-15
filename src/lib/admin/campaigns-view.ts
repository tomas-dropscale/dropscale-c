import type { CampaignActionViewState } from "@/lib/admin/campaign-actions";
import type { AdminCampaignsOverview } from "@/lib/admin/campaigns";

export type CampaignViewStatus = "active" | "paused" | "ended";
export type CampaignViewLoadState =
  | "ready"
  | "empty"
  | "partial"
  | "failed"
  | "not_synced"
  | "disconnected";
export type CampaignViewCampaign = {
  bindingId: string;
  adAccountId: string;
  providerCampaignId: string;
  name: string;
  status: CampaignViewStatus;
  spend: number;
  dailyBudget: string | null;
  currency: string;
  type: string;
  shoppingFeed: boolean;
  googleRoas: number | null;
  actionable: boolean;
};

export type CampaignViewStore = {
  id: string;
  name: string;
  domain: string;
  currency: string;
  realRoas: number | null;
  rollupSpend: number | null;
  rollupComplete: boolean;
  rollupMaterialized?: boolean;
  campaignState: CampaignViewLoadState;
  providerFreshness?: {
    state: "live" | "ready" | "partial" | "not_synced" | "unavailable";
    refreshedAt: string | null;
    lastAttemptAt: string | null;
    lastErrorCode: string | null;
    stale: boolean;
  };
  campaigns: CampaignViewCampaign[];
};

export type CampaignViewClient = {
  id: string;
  name: string;
  email: string;
  currency: string | null;
  revenue: number | null;
  adSpend: number | null;
  realRoas: number | null;
  stores: CampaignViewStore[];
};

/** Loader input must contain only completed, provider-verified campaign actions. */
export type CampaignActionHistory = {
  id: string;
  adAccountId: string;
  providerCampaignId: string;
  campaignName: string;
  action: "budget_changed" | "campaign_paused" | "campaign_enabled" | "campaign_launched";
  outcome: "requested" | "succeeded" | "failed" | "uncertain";
  previousDailyBudget: number | null;
  nextDailyBudget: number | null;
  currency: string;
  occurredAt: string;
  actorName: string;
};

export type CampaignScaleHistory = CampaignActionHistory & {
  action: "budget_changed";
  previousDailyBudget: number;
  nextDailyBudget: number;
};

export type ProjectedCampaign = CampaignViewCampaign & {
  scaleHistory: CampaignScaleHistory[];
  lastScaledAt: string | null;
};

export type ProjectedCampaignClient = Omit<CampaignViewClient, "stores"> & {
  stores: Array<Omit<CampaignViewStore, "campaigns"> & { campaigns: ProjectedCampaign[] }>;
};

export type AdminCampaignsViewProjection = {
  clients: CampaignViewClient[];
  history: CampaignActionHistory[];
  historyTruncated: boolean;
};

const campaignKey = (adAccountId: string, providerCampaignId: string) =>
  `${adAccountId}\u0000${providerCampaignId}`;

const searchText = (value: string) => value.trim().toLocaleLowerCase();

export function filterCampaignClients<T extends CampaignViewClient>(clients: T[], query: string): T[] {
  const needle = searchText(query);
  if (!needle) return clients;

  return clients.filter((client) =>
    [
      client.name,
      client.email,
      ...client.stores.flatMap((store) => [store.name, store.domain]),
    ].some((value) => searchText(value).includes(needle)),
  );
}

function isScale(entry: CampaignActionHistory): entry is CampaignScaleHistory {
  return (
    entry.outcome === "succeeded" &&
    entry.action === "budget_changed" &&
    entry.previousDailyBudget !== null &&
    entry.nextDailyBudget !== null &&
    entry.nextDailyBudget > entry.previousDailyBudget
  );
}

export function projectCampaignClients(
  clients: CampaignViewClient[],
  history: CampaignActionHistory[],
): ProjectedCampaignClient[] {
  const scales = new Map<string, CampaignScaleHistory[]>();

  for (const entry of history) {
    if (!isScale(entry)) continue;
    const key = campaignKey(entry.adAccountId, entry.providerCampaignId);
    const current = scales.get(key) ?? [];
    current.push(entry);
    scales.set(key, current);
  }

  for (const entries of scales.values()) {
    entries.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  return clients.map((client) => ({
    ...client,
    stores: client.stores.map((store) => ({
      ...store,
      campaigns: store.campaigns.map((campaign) => {
        const scaleHistory = scales.get(
          campaignKey(campaign.adAccountId, campaign.providerCampaignId),
        ) ?? [];
        return {
          ...campaign,
          scaleHistory,
          lastScaledAt: scaleHistory[0]?.occurredAt ?? null,
        };
      }),
    })),
  }));
}

/** Normalizes a user-entered account-currency amount without float arithmetic. */
export function normalizeDailyBudgetInput(value: string): string | null {
  const match = /^(\d{1,12})(?:[.,](\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;

  const million = BigInt(1_000_000);
  const micros = BigInt(match[1]) * million + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micros <= BigInt(0)) return null;
  const whole = micros / million;
  const fraction = String(micros % million).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Preserves the exact trusted micros-backed decimal in an editable field. */
export function dailyBudgetDraft(value: string | null): string {
  if (value === null) return "";
  return normalizeDailyBudgetInput(value) ?? "";
}

function decimalMicros(value: string): bigint | null {
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] ?? "").padEnd(6, "0"));
}

export const MIN_CAMPAIGN_DAILY_BUDGET = "1";
export const MAX_CAMPAIGN_DAILY_BUDGET = "1000000";

export function dailyBudgetWithinLimit(value: string): boolean {
  const amountMicros = decimalMicros(value);
  const minimumMicros = decimalMicros(MIN_CAMPAIGN_DAILY_BUDGET);
  const limitMicros = decimalMicros(MAX_CAMPAIGN_DAILY_BUDGET);
  return (
    amountMicros !== null &&
    minimumMicros !== null &&
    limitMicros !== null &&
    amountMicros >= minimumMicros &&
    amountMicros <= limitMicros
  );
}

function microsToCurrencyUnits(value: number | string | null): string | null {
  if (value === null) return null;
  const text = String(value);
  if (!/^\d{1,18}$/.test(text)) return null;
  const micros = BigInt(text);
  const million = BigInt(1_000_000);
  const whole = micros / million;
  const fraction = String(micros % million).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function liveBudget(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function storeDomain(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

export function storeRealRoas(revenue: number | null, adSpend: number): number | null {
  if (revenue === null || !Number.isFinite(revenue) || !Number.isFinite(adSpend) || adSpend <= 0) {
    return null;
  }
  return revenue / adSpend;
}

/** Google conversion value ÷ spend across campaign rows; never average ratios. */
export function totalGoogleRoas(
  campaigns: readonly Pick<CampaignViewCampaign, "spend" | "googleRoas">[],
): number | null {
  let spend = 0;
  let conversionValue = 0;

  for (const campaign of campaigns) {
    if (!Number.isFinite(campaign.spend) || campaign.spend < 0) return null;
    if (campaign.spend === 0) continue;
    if (
      campaign.googleRoas === null ||
      !Number.isFinite(campaign.googleRoas) ||
      campaign.googleRoas < 0
    ) {
      return null;
    }
    spend += campaign.spend;
    conversionValue += campaign.spend * campaign.googleRoas;
  }

  return spend > 0 ? conversionValue / spend : null;
}

const CONTROLLED_ACTIONS: readonly CampaignActionHistory["action"][] = [
  "budget_changed",
  "campaign_paused",
  "campaign_enabled",
];

export function campaignActionBindingIds(overview: AdminCampaignsOverview): string[] {
  return [
    ...new Set(
      overview.clients.flatMap((client) =>
        client.accounts.flatMap((entry) =>
          entry.campaigns.flatMap((campaign) =>
            campaign.reportingBindingId ? [campaign.reportingBindingId] : [],
          ),
        ),
      ),
    ),
  ];
}

/** Projects server-only reporting and 0059 evidence into the serializable client DTO. */
export function projectAdminCampaignsView(
  overview: AdminCampaignsOverview,
  state: CampaignActionViewState,
): AdminCampaignsViewProjection {
  const clients = overview.clients.map((client): CampaignViewClient => ({
    id: client.clientId,
    name: client.clientName,
    email: client.clientEmail,
    currency: client.currency,
    revenue: client.revenue,
    adSpend: client.rollupSpend,
    realRoas: client.realRoas,
    stores: client.accounts.map((entry) => ({
      id: entry.account.id,
      name: entry.account.store_name,
      domain: storeDomain(entry.account.shopify_url),
      currency: entry.account.currency,
      realRoas: (entry.rollupMaterialized ?? entry.rollupComplete)
        ? storeRealRoas(entry.rollupRevenue, entry.rollupSpend)
        : null,
      rollupSpend: (entry.rollupMaterialized ?? entry.rollupComplete)
        ? entry.rollupSpend
        : null,
      rollupComplete: entry.rollupComplete,
      rollupMaterialized: entry.rollupMaterialized,
      campaignState: entry.campaignState,
      providerFreshness: entry.providerFreshness,
      campaigns: entry.campaigns.map((campaign): CampaignViewCampaign => {
        const bindingId = campaign.reportingBindingId ?? "";

        return {
          bindingId,
          adAccountId: campaign.ad_account_id,
          providerCampaignId: campaign.providerCampaignId,
          name: campaign.name,
          status: campaign.status,
          spend: campaign.spend,
          dailyBudget: liveBudget(campaign.daily_budget),
          currency: entry.account.currency,
          type: campaign.advertisingChannelType,
          shoppingFeed: campaign.shoppingFeed,
          googleRoas: Number.isFinite(campaign.googleRoas) ? campaign.googleRoas : null,
          actionable: bindingId.length > 0,
        };
      }),
    })),
  }));

  const history = state.history.flatMap((operation): CampaignActionHistory[] => {
    if (
      operation.status !== "succeeded" ||
      !operation.completed_at ||
      !CONTROLLED_ACTIONS.includes(operation.action as CampaignActionHistory["action"])
    ) {
      return [];
    }
    const actorName = state.actorNames.get(operation.requested_by)?.trim();
    if (!actorName) return [];
    const previous = microsToCurrencyUnits(operation.previous_daily_budget_micros);
    const next = microsToCurrencyUnits(operation.next_daily_budget_micros);
    return [{
      id: operation.id,
      adAccountId: operation.ad_account_id,
      providerCampaignId: operation.provider_campaign_id,
      campaignName: operation.campaign_name,
      action: operation.action as CampaignActionHistory["action"],
      outcome: "succeeded",
      previousDailyBudget: previous === null ? null : Number(previous),
      nextDailyBudget: next === null ? null : Number(next),
      currency: operation.currency,
      occurredAt: operation.completed_at,
      actorName,
    }];
  });

  return { clients, history, historyTruncated: state.historyTruncated };
}
