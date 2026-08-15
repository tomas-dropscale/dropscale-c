import { NextResponse, type NextRequest } from "next/server";

import { syncCommissionLedger } from "@/lib/admin/commission-sync";
import { closedWeekStarting } from "@/lib/billing/weekly";
import {
  captureGoogleBillingStartAsAgency,
  fetchGoogleBillingMetadataAsAgency,
  googleLocalDate,
} from "@/lib/google-ads/billing-start";
import { searchGoogleAds } from "@/lib/google-ads/client";
import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEWED_CUTOVER = "2026-08-03";

type RepairBody = { periodStart?: unknown; reviewedBy?: unknown };

export async function POST(request: NextRequest) {
  const repairSecret = process.env.BILLING_REPAIR_SECRET;
  if (
    !repairSecret ||
    request.headers.get("authorization") !== `Bearer ${repairSecret}`
  ) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as RepairBody | null;
  const periodStart =
    typeof body?.periodStart === "string" ? body.periodStart : "";
  const reviewedBy =
    typeof body?.reviewedBy === "string" ? body.reviewedBy : "";
  const period = closedWeekStarting(periodStart);
  if (!period || !UUID.test(reviewedBy)) {
    return NextResponse.json(
      { error: "A closed billing week and an admin reviewer are required." },
      { status: 422 },
    );
  }

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Billing repair is not configured." }, { status: 503 });
  }

  const { data: reviewer, error: reviewerError } = await service
    .from("profiles")
    .select("id, role")
    .eq("id", reviewedBy)
    .maybeSingle();
  if (reviewerError || reviewer?.role !== "admin") {
    return NextResponse.json({ error: "The reviewer is not an admin." }, { status: 403 });
  }

  const [{ data: accounts, error: accountsError }, { data: starts, error: startsError }] =
    await Promise.all([
      service
        .from("ad_accounts")
        .select(
          "id, client_id, created_at, status, google_ads_customer_id, google_ads_refresh_token, currency",
        )
        .in("status", ["active", "suspended"])
        .not("google_ads_customer_id", "is", null),
      service.from("ad_account_billing_starts").select("ad_account_id"),
    ]);
  if (accountsError || startsError) {
    return NextResponse.json({ error: "Could not load billing starts." }, { status: 500 });
  }

  const adminIds = new Set(
    (
      await service.from("profiles").select("id").eq("role", "admin")
    ).data?.map((row) => row.id) ?? [],
  );
  const startedIds = new Set((starts ?? []).map((row) => row.ad_account_id));
  const missing = (accounts ?? []).filter(
    (account) => !adminIds.has(account.client_id) && !startedIds.has(account.id),
  );

  const outcomes = await Promise.all(
    missing.map(async (account) => {
      try {
        if (
          !account.google_ads_customer_id ||
          !account.google_ads_refresh_token ||
          account.currency.toUpperCase() !== "EUR"
        ) {
          throw new Error("The account is missing its exact EUR Google connection.");
        }
        const refreshToken = await decryptToken(account.google_ads_refresh_token);
        const search = (customerId: string, query: string) =>
          searchGoogleAds(customerId, refreshToken, query);
        const createdAt = new Date(account.created_at);
        const entryDay = googleLocalDate(createdAt, "Europe/Lisbon");

        if (entryDay < REVIEWED_CUTOVER) {
          const captureStartedAt = new Date();
          const metadata = await fetchGoogleBillingMetadataAsAgency(
            account.google_ads_customer_id,
            search,
          );
          const capturedAt = new Date();
          const { data, error } = await service.rpc(
            "commit_reviewed_full_day_billing_start",
            {
              p_account_id: account.id,
              p_metadata_capture_id: crypto.randomUUID(),
              p_google_ads_customer_id: metadata.customerId,
              p_google_local_date: googleLocalDate(createdAt, metadata.timeZone),
              p_google_time_zone: metadata.timeZone,
              p_currency: metadata.currency,
              p_metadata_capture_started_at: captureStartedAt.toISOString(),
              p_metadata_captured_at: capturedAt.toISOString(),
              p_metadata_authority: "client_oauth",
              p_metadata_contract: "google-customer-metadata-v1",
            },
          );
          if (error || !data?.[0]) throw error ?? new Error("No start was committed.");
          return { accountId: account.id, status: "reviewed_full_day" as const };
        }

        const captured = await captureGoogleBillingStartAsAgency(
          account.google_ads_customer_id,
          { search },
        );
        const { data, error } = await service.rpc("commit_google_ads_billing_start", {
          p_account_id: account.id,
          p_request_id: null,
          p_capture_id: captured.capture_id,
          p_google_ads_customer_id: captured.google_ads_customer_id,
          p_google_local_date: captured.google_local_date,
          p_google_time_zone: captured.google_time_zone,
          p_currency: captured.currency,
          p_baseline_cost_micros: captured.baseline_cost_micros,
          p_capture_started_at: captured.capture_started_at,
          p_captured_at: captured.captured_at,
          p_source: captured.source,
          p_reviewed_by: reviewedBy,
        });
        if (error || !data?.[0]) throw error ?? new Error("No start was committed.");
        return { accountId: account.id, status: "observed_google_counter" as const };
      } catch (error) {
        return {
          accountId: account.id,
          status: "failed" as const,
          error: error instanceof Error ? error.message : "Unknown billing-start error",
        };
      }
    }),
  );

  try {
    await syncCommissionLedger({ force: true, client: service, period });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        starts: outcomes,
        error: error instanceof Error ? error.message : "Billing sync failed.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, period, starts: outcomes });
}
