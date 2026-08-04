import { NextResponse, type NextRequest } from "next/server";

import { captureGoogleBillingEndAsAgency } from "@/lib/google-ads/billing-start";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.accountId !== "string") return null;
  const accountId = record.accountId.trim();
  return UUID.test(accountId) ? accountId : null;
}

function canonicalCustomerId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9\s-]+$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/**
 * Capture the cumulative counter currently reported by Google and close commercial billing
 * without changing the account's technical active/suspended status.
 */
export async function POST(request: NextRequest) {
  let accountId: string | null;
  try {
    accountId = accountIdFromBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!accountId) {
    return NextResponse.json(
      { error: "Send exactly one valid accountId." },
      { status: 400 },
    );
  }

  // The browser chooses the account, but only a database-verified admin may
  // open the agency Google connection or obtain a service-role client.
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  const { data: profile, error: profileError } = await session
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: "Could not verify the admin session." }, { status: 500 });
  }
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { data: account, error: accountError } = await session
    .from("ad_accounts")
    .select("id, store_name, google_ads_customer_id, status")
    .eq("id", accountId)
    .maybeSingle();
  if (accountError) {
    return NextResponse.json({ error: "Could not load the ad account." }, { status: 500 });
  }
  if (!account) {
    return NextResponse.json({ error: "Ad account not found." }, { status: 404 });
  }
  if (!["active", "suspended"].includes(account.status)) {
    return NextResponse.json(
      { error: "Only an approved Google account can stop billing." },
      { status: 409 },
    );
  }

  const [{ data: billingStart, error: startError }, { data: existingEnd, error: endError }] =
    await Promise.all([
      session
        .from("ad_account_billing_starts")
        .select(
          "id, google_ads_customer_id, google_local_date, google_time_zone, currency",
        )
        .eq("ad_account_id", account.id)
        .maybeSingle(),
      session
        .from("ad_account_billing_ends")
        .select("id")
        .eq("ad_account_id", account.id)
        .maybeSingle(),
    ]);
  if (startError || endError) {
    return NextResponse.json(
      { error: "Could not audit this account's billing boundaries." },
      { status: 500 },
    );
  }
  if (!billingStart) {
    return NextResponse.json(
      { error: "This account has no Google billing start to close." },
      { status: 409 },
    );
  }
  if (existingEnd) {
    return NextResponse.json(
      { error: "Billing has already ended for this Google account." },
      { status: 409 },
    );
  }

  const googleAdsCustomerId = canonicalCustomerId(account.google_ads_customer_id);
  if (!googleAdsCustomerId || googleAdsCustomerId !== billingStart.google_ads_customer_id) {
    return NextResponse.json(
      { error: "The account's Google identity no longer matches its billing start." },
      { status: 409 },
    );
  }

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "Server-side billing termination is not configured." },
      { status: 503 },
    );
  }

  let captured;
  try {
    captured = await captureGoogleBillingEndAsAgency(googleAdsCustomerId);
  } catch (error) {
    console.error("Google billing-end capture failed:", {
      accountId: account.id,
      message: error instanceof Error ? error.message : "Unknown Google Ads error",
    });
    return NextResponse.json(
      {
        error:
          "Google Ads could not capture the closing counter. Billing is still active; confirm agency access and try again.",
      },
      { status: 502 },
    );
  }

  if (
    captured.google_ads_customer_id !== billingStart.google_ads_customer_id ||
    captured.google_time_zone !== billingStart.google_time_zone ||
    captured.currency !== billingStart.currency.toUpperCase() ||
    captured.google_local_date < billingStart.google_local_date
  ) {
    console.error("Google billing-end evidence mismatch:", { accountId: account.id });
    return NextResponse.json(
      { error: "Google returned evidence that does not match the billing start; billing is still active." },
      { status: 502 },
    );
  }

  const { data: committedEnds, error: commitError } = await service.rpc(
    "commit_google_ads_billing_end",
    {
      p_account_id: account.id,
      p_capture_id: captured.capture_id,
      p_google_ads_customer_id: captured.google_ads_customer_id,
      p_google_local_date: captured.google_local_date,
      p_google_time_zone: captured.google_time_zone,
      p_currency: captured.currency,
      p_end_cost_micros: captured.end_cost_micros,
      p_capture_started_at: captured.capture_started_at,
      p_captured_at: captured.captured_at,
      p_source: captured.source,
      p_reviewed_by: profile.id,
    },
  );

  const committedEnd = committedEnds?.[0] ?? null;
  if (commitError || !committedEnd) {
    console.error("Google billing-end commit failed:", {
      accountId: account.id,
      code: commitError?.code ?? null,
      message: commitError?.message ?? "RPC returned no billing end",
    });
    const conflict =
      commitError?.code === "23505" ||
      commitError?.code === "22023" ||
      commitError?.code === "P0001";
    return NextResponse.json(
      {
        error:
          commitError?.message ??
          "The account changed while it was being reviewed; billing remains active.",
      },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    account: {
      id: account.id,
      storeName: account.store_name,
      status: account.status,
    },
    billingEnd: {
      id: committedEnd.id,
      billingStartId: committedEnd.billing_start_id,
      googleAdsCustomerId: captured.google_ads_customer_id,
      googleLocalDate: captured.google_local_date,
      googleTimeZone: captured.google_time_zone,
      currency: captured.currency,
      endCostMicros: captured.end_cost_micros,
      captureStartedAt: captured.capture_started_at,
      capturedAt: captured.captured_at,
      captureId: captured.capture_id,
      source: captured.source,
    },
  });
}
