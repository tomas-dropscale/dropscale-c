import "server-only";

import {
  mutateGoogleAdsAsAgency,
  searchGoogleAdsAsAgency,
  type GaqlRow,
  type GoogleAdsMutateResponse,
} from "./client";

const CUSTOMER_ID = /^\d{10}$/;
const CAMPAIGN_ID = /^\d{1,30}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_BUDGET_MICROS = 1_000_000_000_000;
const PROVIDER_EXECUTION_DEADLINE_MS = 2 * 60 * 1_000;

export type GoogleCampaignControlStatus = "active" | "paused" | "ended";

export type GoogleCampaignControlState = {
  customerId: string;
  campaignId: string;
  campaignName: string;
  campaignResourceName: string;
  status: GoogleCampaignControlStatus;
  currency: string;
  timeZone: string;
  dailyBudget: number | null;
  budgetMicros: number | null;
  budgetResourceName: string | null;
  budgetPeriod: "DAILY" | "CUSTOM_PERIOD" | null;
  totalBudgetMicros: number | null;
  sharedBudget: boolean;
};

export type GoogleCampaignControlReceipt = {
  before: GoogleCampaignControlState;
  after: GoogleCampaignControlState;
  requestId: string | null;
};

type CampaignSearch = (customerId: string, query: string) => Promise<GaqlRow[]>;
type CampaignMutate = typeof mutateGoogleAdsAsAgency;

type Dependencies = {
  search?: CampaignSearch;
  mutate?: CampaignMutate;
};

export class GoogleCampaignControlError extends Error {
  constructor(
    readonly code:
      | "invalid_target"
      | "campaign_unavailable"
      | "campaign_changed"
      | "shared_budget"
      | "execution_expired"
      | "provider_mismatch",
    message: string,
    /** The actual mutate was sent, so callers must reconcile and never retry blindly. */
    readonly indeterminate = false,
  ) {
    super(message);
    this.name = "GoogleCampaignControlError";
  }
}

function assertExecutionDeadline(deadlineAt: number) {
  if (Date.now() >= deadlineAt) {
    throw new GoogleCampaignControlError(
      "execution_expired",
      "The campaign action expired before Google Ads could be mutated.",
    );
  }
}

function canonicalCustomerId(value: unknown): string | null {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^[0-9\s-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return CUSTOMER_ID.test(digits) ? digits : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : typeof value === "number"
      ? value
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function expectedResourceName(
  customerId: string,
  kind: "campaigns" | "campaignBudgets",
  resourceId: string,
) {
  return `customers/${customerId}/${kind}/${resourceId}`;
}

function statusFromGoogle(value: unknown): GoogleCampaignControlStatus | null {
  if (value === "ENABLED") return "active";
  if (value === "PAUSED") return "paused";
  if (value === "REMOVED") return "ended";
  return null;
}

function providerState(customerId: string, campaignId: string, row: GaqlRow) {
  const campaign = record(row.campaign);
  const budget = record(row.campaignBudget);
  const customer = record(row.customer);
  const returnedCustomerId = canonicalCustomerId(customer?.id);
  const returnedCampaignId = String(campaign?.id ?? "").trim();
  const campaignResourceName = String(campaign?.resourceName ?? "").trim();
  const campaignName = String(campaign?.name ?? "").trim();
  const status = statusFromGoogle(campaign?.status);
  const currency = String(customer?.currencyCode ?? "").trim().toUpperCase();
  const timeZone = String(customer?.timeZone ?? "").trim();
  const budgetResourceName = String(
    budget?.resourceName ?? campaign?.campaignBudget ?? "",
  ).trim();
  const budgetId = String(budget?.id ?? "").trim();
  const budgetMicros = budget?.amountMicros == null
    ? null
    : nonNegativeSafeInteger(budget.amountMicros);
  const referenceCount = budget?.referenceCount == null
    ? null
    : nonNegativeSafeInteger(budget.referenceCount);
  const budgetPeriod = budget?.period === "DAILY" || budget?.period === "CUSTOM_PERIOD"
    ? budget.period
    : null;
  const totalBudgetMicros = budget?.totalAmountMicros == null
    ? null
    : nonNegativeSafeInteger(budget.totalAmountMicros);

  if (
    returnedCustomerId !== customerId ||
    returnedCampaignId !== campaignId ||
    campaignResourceName !== expectedResourceName(customerId, "campaigns", campaignId) ||
    !campaignName ||
    campaignName.length > 500 ||
    !status ||
    !CURRENCY.test(currency) ||
    !timeZone ||
    timeZone.length > 100 ||
    (budget?.amountMicros != null && budgetMicros === null) ||
    (budgetResourceName &&
      (typeof budget?.explicitlyShared !== "boolean" || referenceCount === null)) ||
    (budget?.totalAmountMicros != null && totalBudgetMicros === null) ||
    (budgetResourceName &&
      (!/^\d{1,30}$/.test(budgetId) ||
        budgetResourceName !== expectedResourceName(customerId, "campaignBudgets", budgetId) ||
        budgetPeriod === null))
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads returned a different or malformed campaign identity.",
    );
  }

  return {
    customerId,
    campaignId,
    campaignName,
    campaignResourceName,
    status,
    currency,
    timeZone,
    dailyBudget: budgetMicros === null ? null : budgetMicros / 1_000_000,
    budgetMicros,
    budgetResourceName: budgetResourceName || null,
    budgetPeriod,
    totalBudgetMicros,
    sharedBudget: budget?.explicitlyShared === true || (referenceCount ?? 0) > 1,
  } satisfies GoogleCampaignControlState;
}

export async function readGoogleCampaignControlState(
  customerId: string,
  campaignId: string,
  dependencies: Dependencies = {},
): Promise<GoogleCampaignControlState> {
  if (!CUSTOMER_ID.test(customerId) || !CAMPAIGN_ID.test(campaignId)) {
    throw new GoogleCampaignControlError("invalid_target", "Invalid Google Ads campaign target.");
  }

  const search = dependencies.search ?? searchGoogleAdsAsAgency;
  const rows = await search(
    customerId,
    `SELECT
       customer.id,
       customer.currency_code,
       customer.time_zone,
       campaign.id,
       campaign.resource_name,
       campaign.name,
       campaign.status,
       campaign.campaign_budget,
       campaign_budget.id,
       campaign_budget.resource_name,
       campaign_budget.amount_micros,
       campaign_budget.period,
       campaign_budget.total_amount_micros,
       campaign_budget.explicitly_shared,
       campaign_budget.reference_count
     FROM campaign
     WHERE campaign.id = ${campaignId}`,
  );
  if (rows.length !== 1) {
    throw new GoogleCampaignControlError(
      "campaign_unavailable",
      "Google Ads returned no unique campaign.",
    );
  }
  return providerState(customerId, campaignId, rows[0]);
}

function singleMutableResource(
  response: GoogleAdsMutateResponse,
  key: "campaign" | "campaignBudget",
): Record<string, unknown> {
  if (response.results.length !== 1) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads returned no unique mutation result.",
    );
  }
  const resource = record(response.results[0]?.[key]);
  if (!resource) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads returned no mutable resource receipt.",
    );
  }
  return resource;
}

export async function updateGoogleCampaignBudget(
  input: {
    customerId: string;
    campaignId: string;
    expectedBudgetMicros: number;
    nextBudgetMicros: number;
    maxBudgetMicros: number;
    expectedCurrency: string;
    expectedTimeZone: string;
  },
  dependencies: Dependencies = {},
): Promise<GoogleCampaignControlReceipt> {
  const executionDeadline = Date.now() + PROVIDER_EXECUTION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(input.expectedBudgetMicros) ||
    input.expectedBudgetMicros < 0 ||
    !Number.isSafeInteger(input.nextBudgetMicros) ||
    input.nextBudgetMicros < 1_000_000 ||
    input.nextBudgetMicros > MAX_BUDGET_MICROS ||
    !Number.isSafeInteger(input.maxBudgetMicros) ||
    input.maxBudgetMicros < 1_000_000 ||
    input.nextBudgetMicros > input.maxBudgetMicros ||
    !CURRENCY.test(input.expectedCurrency) ||
    !input.expectedTimeZone ||
    input.expectedTimeZone.length > 100
  ) {
    throw new GoogleCampaignControlError(
      "invalid_target",
      "Daily budget must be between 1 and 1,000,000 account-currency units.",
    );
  }
  const before = await readGoogleCampaignControlState(
    input.customerId,
    input.campaignId,
    dependencies,
  );
  if (
    before.currency !== input.expectedCurrency ||
    before.timeZone !== input.expectedTimeZone
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads returned a different reporting identity.",
    );
  }
  if (
    before.status === "ended" ||
    before.budgetMicros === null ||
    !before.budgetResourceName ||
    before.budgetPeriod !== "DAILY"
  ) {
    throw new GoogleCampaignControlError(
      "campaign_unavailable",
      "This campaign has no editable daily budget.",
    );
  }
  if (before.sharedBudget) {
    throw new GoogleCampaignControlError(
      "shared_budget",
      "This budget is shared by multiple campaigns and cannot be changed here.",
    );
  }
  if (before.budgetMicros !== input.expectedBudgetMicros) {
    throw new GoogleCampaignControlError(
      "campaign_changed",
      "The campaign budget changed before this action could run.",
    );
  }
  if (before.budgetMicros === input.nextBudgetMicros) {
    throw new GoogleCampaignControlError("campaign_changed", "The campaign already has this budget.");
  }

  const mutate = dependencies.mutate ?? mutateGoogleAdsAsAgency;
  const operation = {
    update: {
      resourceName: before.budgetResourceName,
      amountMicros: String(input.nextBudgetMicros),
    },
    updateMask: "amount_micros",
  };
  assertExecutionDeadline(executionDeadline);
  await mutate(input.customerId, "campaignBudgets", [operation], { validateOnly: true });
  assertExecutionDeadline(executionDeadline);
  const response = await mutate(input.customerId, "campaignBudgets", [operation], {
    validateOnly: false,
  });
  let mutable: Record<string, unknown>;
  try {
    mutable = singleMutableResource(response, "campaignBudget");
  } catch {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads did not return a verifiable campaign budget receipt.",
      true,
    );
  }
  if (
    mutable.resourceName !== before.budgetResourceName ||
    nonNegativeSafeInteger(mutable.amountMicros) !== input.nextBudgetMicros
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads did not confirm the requested campaign budget.",
      true,
    );
  }

  let after: GoogleCampaignControlState;
  try {
    after = await readGoogleCampaignControlState(
      input.customerId,
      input.campaignId,
      dependencies,
    );
  } catch {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "The campaign budget could not be read after the update.",
      true,
    );
  }
  if (
    after.status === "ended" ||
    after.budgetResourceName !== before.budgetResourceName ||
    after.budgetMicros !== input.nextBudgetMicros ||
    after.budgetPeriod !== "DAILY" ||
    after.sharedBudget ||
    after.currency !== input.expectedCurrency ||
    after.timeZone !== input.expectedTimeZone
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "The campaign budget could not be verified after the update.",
      true,
    );
  }
  return { before, after, requestId: response.requestId };
}

export async function updateGoogleCampaignStatus(
  input: {
    customerId: string;
    campaignId: string;
    expectedStatus: Exclude<GoogleCampaignControlStatus, "ended">;
    nextStatus: Exclude<GoogleCampaignControlStatus, "ended">;
    expectedCurrency: string;
    expectedTimeZone: string;
  },
  dependencies: Dependencies = {},
): Promise<GoogleCampaignControlReceipt> {
  const executionDeadline = Date.now() + PROVIDER_EXECUTION_DEADLINE_MS;
  if (input.expectedStatus === input.nextStatus) {
    throw new GoogleCampaignControlError("invalid_target", "Campaign status must change.");
  }
  if (
    !CURRENCY.test(input.expectedCurrency) ||
    !input.expectedTimeZone ||
    input.expectedTimeZone.length > 100
  ) {
    throw new GoogleCampaignControlError(
      "invalid_target",
      "Invalid Google Ads reporting identity.",
    );
  }
  const before = await readGoogleCampaignControlState(
    input.customerId,
    input.campaignId,
    dependencies,
  );
  if (
    before.currency !== input.expectedCurrency ||
    before.timeZone !== input.expectedTimeZone
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads returned a different reporting identity.",
    );
  }
  if (before.status !== input.expectedStatus) {
    throw new GoogleCampaignControlError(
      "campaign_changed",
      "The campaign status changed before this action could run.",
    );
  }

  const googleStatus = input.nextStatus === "active" ? "ENABLED" : "PAUSED";
  const operation = {
    update: {
      resourceName: before.campaignResourceName,
      status: googleStatus,
    },
    updateMask: "status",
  };
  const mutate = dependencies.mutate ?? mutateGoogleAdsAsAgency;
  assertExecutionDeadline(executionDeadline);
  await mutate(input.customerId, "campaigns", [operation], { validateOnly: true });
  assertExecutionDeadline(executionDeadline);
  const response = await mutate(input.customerId, "campaigns", [operation], {
    validateOnly: false,
  });
  let mutable: Record<string, unknown>;
  try {
    mutable = singleMutableResource(response, "campaign");
  } catch {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads did not return a verifiable campaign status receipt.",
      true,
    );
  }
  if (
    mutable.resourceName !== before.campaignResourceName ||
    statusFromGoogle(mutable.status) !== input.nextStatus
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "Google Ads did not confirm the requested campaign status.",
      true,
    );
  }

  let after: GoogleCampaignControlState;
  try {
    after = await readGoogleCampaignControlState(
      input.customerId,
      input.campaignId,
      dependencies,
    );
  } catch {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "The campaign status could not be read after the update.",
      true,
    );
  }
  if (
    after.status !== input.nextStatus ||
    after.currency !== input.expectedCurrency ||
    after.timeZone !== input.expectedTimeZone
  ) {
    throw new GoogleCampaignControlError(
      "provider_mismatch",
      "The campaign status could not be verified after the update.",
      true,
    );
  }
  return { before, after, requestId: response.requestId };
}
