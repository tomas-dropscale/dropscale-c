import { NextResponse, type NextRequest } from "next/server";

import {
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import {
  listAdminReportingStoreScopes,
  refreshAdminCampaignSnapshots,
} from "@/lib/admin/campaigns";
import {
  ensureAdminAnalyticsRollupCoverage,
  refreshAdminStoreAnalyticsSnapshots,
} from "@/lib/admin/store-analytics";
import { parseRange, presetSelection, type RangeSelection } from "@/lib/portal/range";
import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const STORE_REFRESH_CONCURRENCY = 3;
const REPORTING_ROUTE_BUDGET_MS = 120_000;
const PROVIDER_REFRESH_TIMEOUT_MS = 45_000;

type StoreRequest = {
  scope: "store";
  clientId: string;
  store: {
    accountId: string;
    activityAccountIds: string[];
    currency: string;
  };
  range: RangeSelection;
};

type CampaignsRequest = {
  scope: "campaigns";
  range: RangeSelection;
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function withinProviderDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Reporting provider refresh timed out.")),
          PROVIDER_REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function exactRange(value: unknown): RangeSelection | null {
  if (
    !isExactRecord(value, ["key", "from", "to"]) ||
    typeof value.key !== "string" ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !["today", "yesterday", "d7", "d30", "mtd", "ytd", "custom"].includes(value.key)
  ) {
    return null;
  }
  const parsed = parseRange({
    range: value.key,
    from: value.from,
    to: value.to,
  });
  return parsed.key === value.key && parsed.from === value.from && parsed.to === value.to
    ? parsed
    : null;
}

function parseManualRequest(value: unknown): CampaignsRequest | StoreRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = (value as Record<string, unknown>).scope;
  if (scope === "campaigns" && isExactRecord(value, ["scope", "range"])) {
    const range = exactRange(value.range);
    return range ? { scope, range } : null;
  }
  if (scope !== "store" || !isExactRecord(value, ["scope", "clientId", "store", "range"])) {
    return null;
  }
  const range = exactRange(value.range);
  const store = value.store;
  if (
    !range ||
    typeof value.clientId !== "string" ||
    !UUID.test(value.clientId) ||
    !isExactRecord(store, ["accountId", "activityAccountIds", "currency"]) ||
    typeof store.accountId !== "string" ||
    !UUID.test(store.accountId) ||
    !Array.isArray(store.activityAccountIds) ||
    store.activityAccountIds.length < 1 ||
    store.activityAccountIds.length > 100 ||
    store.activityAccountIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    !store.activityAccountIds.includes(store.accountId) ||
    typeof store.currency !== "string" ||
    !/^[A-Z]{3}$/.test(store.currency)
  ) {
    return null;
  }
  return {
    scope,
    clientId: value.clientId,
    store: {
      accountId: store.accountId,
      activityAccountIds: [...new Set(store.activityAccountIds)],
      currency: store.currency,
    },
    range,
  };
}

async function refreshStore(request: StoreRequest) {
  const metricCoverage = await ensureAdminAnalyticsRollupCoverage(
    {
      clientId: request.clientId,
      stores: [request.store],
      range: request.range,
    },
    { authenticate: false },
  );
  const result = await refreshAdminStoreAnalyticsSnapshots(
    {
      clientId: request.clientId,
      store: { ...request.store, days: [] },
      range: request.range,
    },
    { authenticate: false },
  );
  return {
    ok: result.failed === 0 && result.partial === 0 && metricCoverage.state === "ready",
    scope: "store" as const,
    metricCoverage,
    result,
  };
}

async function refreshAll(range: RangeSelection) {
  const startedAt = Date.now();
  const deadline = startedAt + REPORTING_ROUTE_BUDGET_MS;
  const service = createServiceClient();
  if (!service) return response({ error: "Reporting sync is not configured." }, 503);

  type CampaignRefresh = Awaited<ReturnType<typeof refreshAdminCampaignSnapshots>>;
  let campaigns: CampaignRefresh;
  try {
    campaigns = await withinProviderDeadline(refreshAdminCampaignSnapshots(range, {
      authenticate: false,
      client: service,
    }));
  } catch {
    campaigns = {
      from: range.from,
      to: range.to,
      accounts: 0,
      metricCoverage: null,
      refreshed: 0,
      partial: 0,
      busy: 0,
      failed: 1,
    };
  }
  const scopes = await listAdminReportingStoreScopes(service);
  // Rotate the first store every hour. If an outage exhausts the budget, the
  // same tail cannot be starved forever by always restarting at index zero.
  const startOffset = scopes.length > 0
    ? Math.floor(startedAt / 3_600_000) % scopes.length
    : 0;
  const orderedScopes = [
    ...scopes.slice(startOffset),
    ...scopes.slice(0, startOffset),
  ];
  type StoreRefresh = Awaited<ReturnType<typeof refreshAdminStoreAnalyticsSnapshots>>;
  const stores: StoreRefresh[] = [];
  let nextScope = 0;
  const worker = async () => {
    while (nextScope < orderedScopes.length) {
      // The scheduled handler still has metrics, the second reporting range and
      // ledgers to run. Do not launch more provider work after this leg's budget.
      if (Date.now() >= deadline) return;
      const scope = orderedScopes[nextScope++];
      try {
        stores.push(await withinProviderDeadline(refreshAdminStoreAnalyticsSnapshots(
          {
            clientId: scope.clientId,
            store: { ...scope.store, days: [] },
            range,
          },
          { authenticate: false },
        )));
      } catch {
        stores.push({
          accountId: scope.store.accountId,
          from: range.from,
          to: range.to,
          refreshed: 0,
          partial: 0,
          busy: 0,
          failed: 1,
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(STORE_REFRESH_CONCURRENCY, scopes.length) },
      () => worker(),
    ),
  );
  const skippedStores = orderedScopes.length - nextScope;
  const failed = campaigns.failed + stores.reduce((sum, store) => sum + store.failed, 0);
  const partial = campaigns.partial + stores.reduce((sum, store) => sum + store.partial, 0);
  const degraded = failed + partial + skippedStores;
  return response(
    {
      ok: degraded === 0,
      scope: "hourly",
      range,
      campaigns,
      stores,
      budget: {
        limitMs: REPORTING_ROUTE_BUDGET_MS,
        exhausted: skippedStores > 0,
        startOffset,
        launchedStores: nextScope,
        skippedStores,
      },
      syncedAt: new Date().toISOString(),
      ...(degraded > 0
        ? {
            error: skippedStores > 0
              ? "Reporting sync reached its route budget; remaining stores were not launched."
              : "Some reporting families could not be fully refreshed.",
          }
        : {}),
    },
    degraded > 0 ? 502 : 200,
  );
}

/** Exact-range manual sync, or the CRON_SECRET-protected hourly today/d7 sync. */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const machineAuthorised = Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );

  if (!machineAuthorised) {
    const { profile } = await getSessionProfile();
    if (profile?.role !== "admin") return response({ error: "Forbidden." }, 403);
  }
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  try {
    if (machineAuthorised) {
      const key = request.nextUrl.searchParams.get("range");
      if (key !== "today" && key !== "d7") {
        return response({ error: "Cron reporting range must be today or d7." }, 422);
      }
      return await refreshAll(presetSelection(key));
    }

    const body = parseManualRequest(await readSmallJson(request, 2_048));
    if (!body) return response({ error: "Send one valid exact reporting scope and range." }, 422);
    if (body.scope === "store") {
      const refreshed = await refreshStore(body);
      return response(
        {
          ...refreshed,
          syncedAt: new Date().toISOString(),
          ...(!refreshed.ok ? { error: "Store reporting could not be fully refreshed." } : {}),
        },
        refreshed.ok ? 200 : 502,
      );
    }

    const service = createServiceClient();
    if (!service) return response({ error: "Reporting sync is not configured." }, 503);
    const result = await refreshAdminCampaignSnapshots(body.range, {
      authenticate: false,
      client: service,
      refreshMetrics: true,
    });
    const metricsReady = result.metricCoverage?.state === "ready";
    const snapshotsReady = result.failed === 0 && result.partial === 0;
    return response(
      {
        ok: snapshotsReady && metricsReady,
        scope: body.scope,
        result,
        syncedAt: new Date().toISOString(),
        ...(!snapshotsReady || !metricsReady
          ? { error: "Campaign reporting could not be fully refreshed." }
          : {}),
      },
      !snapshotsReady || !metricsReady ? 502 : 200,
    );
  } catch (error) {
    if (error instanceof ClientOnboardingError) {
      return response({ error: error.message }, error.status);
    }
    console.error("Admin reporting sync failed.");
    return response({ error: "Reporting sync failed." }, 500);
  }
}
