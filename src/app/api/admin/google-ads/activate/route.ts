import { NextResponse, type NextRequest } from "next/server";

import {
  captureBillingStartFromConnection,
  captureGoogleBillingStartAsAgency,
  type CapturedGoogleBillingStart,
} from "@/lib/google-ads/billing-start";
import { searchGoogleAds } from "@/lib/google-ads/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ActivationTarget =
  | { kind: "account"; id: string }
  | { kind: "request"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activationTarget(body: unknown): ActivationTarget | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) return null;

  const key = keys[0];
  if (key !== "accountId" && key !== "requestId") return null;

  const value = record[key];
  if (typeof value !== "string" || !UUID.test(value.trim())) return null;

  return key === "accountId"
    ? { kind: "account", id: value.trim() }
    : { kind: "request", id: value.trim() };
}

function canonicalCustomerId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9\s-]+$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/**
 * A zero baseline drawn from the Google reporting connection this account is
 * bound to, for when the live agency read cannot reach it.
 *
 * The connection must be the healthy EUR source for exactly this customer id —
 * the same identity, currency and time-zone gates ensureAutomaticBillingStarts
 * proves before it writes its own zero baseline. Anything short of that returns
 * null, and the caller keeps the original "could not verify" failure rather
 * than inventing a baseline for an account we cannot stand behind.
 */
async function captureFromReportingConnection(
  service: SupabaseClient,
  adAccountId: string,
  customerId: string,
): Promise<CapturedGoogleBillingStart | null> {
  // Any failure here means "no fallback", never a crash: the live read already
  // failed, and the caller's own 502 is the right answer if this cannot stand
  // in for it.
  try {
    const { data: binding } = await service
      .from("client_reporting_bindings")
      .select("google_ads_connection_id")
      .eq("ad_account_id", adAccountId)
      .in("status", ["active", "staged"])
      .not("google_ads_connection_id", "is", null)
      .maybeSingle();
    const connectionId = (binding as { google_ads_connection_id?: string } | null)
      ?.google_ads_connection_id;
    if (!connectionId) return null;

    const { data: connection } = await service
      .from("client_google_ads_connections")
      .select("status, currency, time_zone, windsor_account_id")
      .eq("id", connectionId)
      .maybeSingle();
    const row = connection as
      | {
          status: string;
          currency: string | null;
          time_zone: string | null;
          windsor_account_id: string;
        }
      | null;
    if (
      !row ||
      row.status !== "connected" ||
      canonicalCustomerId(row.windsor_account_id) !== customerId ||
      (row.currency ?? "").toUpperCase() !== "EUR" ||
      !row.time_zone?.trim()
    ) {
      return null;
    }

    return captureBillingStartFromConnection({
      customerId,
      currency: row.currency ?? "",
      timeZone: row.time_zone,
    });
  } catch {
    return null;
  }
}

/**
 * Verify Google access, record the opening same-day counter returned by Google and only
 * then make an account billable. The database RPC owns the final, atomic
 * status/request transition; no write happens before the live Google read.
 */
export async function POST(request: NextRequest) {
  let target: ActivationTarget | null;
  try {
    target = activationTarget(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!target) {
    return NextResponse.json(
      { error: "Send exactly one valid accountId or requestId." },
      { status: 400 },
    );
  }

  // Authenticate with the viewer's session before touching the agency Google
  // connection or creating a service-role client.
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

  let googleAdsCustomerId: string | null = null;
  let storeName = "Google Ads account";

  if (target.kind === "account") {
    const { data: account, error } = await session
      .from("ad_accounts")
      .select("id, store_name, google_ads_customer_id, status")
      .eq("id", target.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "Could not load the ad account." }, { status: 500 });
    }
    if (!account) {
      return NextResponse.json({ error: "Ad account not found." }, { status: 404 });
    }
    if (!["pending", "active", "suspended"].includes(account.status)) {
      return NextResponse.json(
        { error: "This ad account cannot start Google tracking from its current state." },
        { status: 409 },
      );
    }

    const { data: existingStart, error: billingStartError } = await session
      .from("ad_account_billing_starts")
      .select("id")
      .eq("ad_account_id", account.id)
      .maybeSingle();
    if (billingStartError) {
      return NextResponse.json(
        { error: "Could not audit this account's existing billing start." },
        { status: 500 },
      );
    }
    if (existingStart) {
      return NextResponse.json(
        { error: "This ad account already has a Google billing start." },
        { status: 409 },
      );
    }

    googleAdsCustomerId = canonicalCustomerId(account.google_ads_customer_id);
    storeName = account.store_name;
  } else {
    const { data: accountRequest, error } = await session
      .from("account_requests")
      .select("id, request_type, google_ads_customer_id, store_name, status")
      .eq("id", target.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "Could not load the account request." }, { status: 500 });
    }
    if (!accountRequest) {
      return NextResponse.json({ error: "Account request not found." }, { status: 404 });
    }
    if (accountRequest.request_type !== "google_ads") {
      return NextResponse.json(
        { error: "Only Google Ads requests can start Google tracking." },
        { status: 422 },
      );
    }
    if (accountRequest.status !== "pending") {
      return NextResponse.json(
        { error: "This Google Ads request has already been reviewed." },
        { status: 409 },
      );
    }

    googleAdsCustomerId = canonicalCustomerId(accountRequest.google_ads_customer_id);
    storeName = accountRequest.store_name?.trim() || storeName;
  }

  if (!googleAdsCustomerId) {
    return NextResponse.json(
      { error: "Add a valid 10-digit Google Ads customer ID before starting tracking." },
      { status: 422 },
    );
  }

  if (target.kind === "request") {
    const { data: existingStart, error: billingStartError } = await session
      .from("ad_account_billing_starts")
      .select("id")
      .eq("google_ads_customer_id", googleAdsCustomerId)
      .maybeSingle();
    if (billingStartError) {
      return NextResponse.json(
        { error: "Could not audit existing Google billing starts." },
        { status: 500 },
      );
    }
    if (existingStart) {
      return NextResponse.json(
        { error: "This Google Ads customer already has a billing start." },
        { status: 409 },
      );
    }
  }

  // Fail before the Google request if this deployment cannot perform the
  // atomic commit. Merely constructing this client happens only after admin
  // authentication and the RLS-checked target read above.
  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "Server-side billing activation is not configured." },
      { status: 503 },
    );
  }

  let captured;
  try {
    let search;
    if (target.kind === "account") {
      const { data: secret, error: secretError } = await service
        .from("ad_accounts")
        .select("google_ads_refresh_token")
        .eq("id", target.id)
        .maybeSingle();
      if (secretError) throw secretError;
      // A legacy account carries the client's own Google grant, and reading
      // through it is exact. A V2 reporting account never does — that grant
      // lives on the reporting connection, and these accounts are read through
      // the agency manager. Requiring a per-account token here made this
      // unreachable for every staged V2 source, and the failure was reported
      // as Google refusing an account it was never asked about.
      if (secret?.google_ads_refresh_token) {
        const refreshToken = await decryptToken(secret.google_ads_refresh_token);
        search = (customerId: string, query: string) =>
          searchGoogleAds(customerId, refreshToken, query);
      }
    }
    captured = await captureGoogleBillingStartAsAgency(
      googleAdsCustomerId,
      search ? { search } : {},
    );
  } catch (error) {
    // The live read failed: no per-account grant and the agency manager cannot
    // see this account. For a source connected through Windsor that is the
    // normal case, not an error — the grant is Windsor's, never ours. Fall back
    // to the zero baseline the automatic path already writes for such accounts,
    // built from the reporting connection this account is bound to.
    const fallback =
      target.kind === "account"
        ? await captureFromReportingConnection(service, target.id, googleAdsCustomerId)
        : null;
    if (!fallback) {
      console.error("Google billing-start capture failed:", {
        targetKind: target.kind,
        targetId: target.id,
        message: error instanceof Error ? error.message : "Unknown Google Ads error",
      });
      return NextResponse.json(
        {
          error: `Google Ads could not verify ${googleAdsCustomerId.slice(0, 3)}-${googleAdsCustomerId.slice(3, 6)}-${googleAdsCustomerId.slice(6)}, and it has no connected reporting source to take a zero baseline from; tracking has not started.`,
        },
        { status: 502 },
      );
    }
    captured = fallback;
  }

  if (captured.google_ads_customer_id !== googleAdsCustomerId) {
    console.error("Google billing-start identity mismatch:", {
      targetKind: target.kind,
      targetId: target.id,
    });
    return NextResponse.json(
      { error: "Google returned a different customer identity; tracking has not started." },
      { status: 502 },
    );
  }

  const { data: committedAccounts, error: commitError } = await service.rpc(
    "commit_google_ads_billing_start",
    {
      p_account_id: target.kind === "account" ? target.id : null,
      p_request_id: target.kind === "request" ? target.id : null,
      p_capture_id: captured.capture_id,
      p_google_ads_customer_id: captured.google_ads_customer_id,
      p_google_local_date: captured.google_local_date,
      p_google_time_zone: captured.google_time_zone,
      p_currency: captured.currency,
      p_baseline_cost_micros: captured.baseline_cost_micros,
      p_capture_started_at: captured.capture_started_at,
      p_captured_at: captured.captured_at,
      p_source: captured.source,
      p_reviewed_by: profile.id,
    },
  );

  const committedAccount = committedAccounts?.[0] ?? null;
  if (commitError || !committedAccount) {
    console.error("Google billing-start commit failed:", {
      targetKind: target.kind,
      targetId: target.id,
      code: commitError?.code ?? null,
      message: commitError?.message ?? "RPC returned no account",
    });
    const conflict =
      commitError?.code === "23505" ||
      commitError?.code === "22023" ||
      commitError?.code === "P0001";
    return NextResponse.json(
      {
        error:
          commitError?.message ??
          "The account changed while it was being reviewed; tracking has not started.",
      },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    account: {
      id: committedAccount.id,
      storeName: committedAccount.store_name || storeName,
      status: committedAccount.status,
    },
    billingStart: {
      googleAdsCustomerId: captured.google_ads_customer_id,
      googleLocalDate: captured.google_local_date,
      googleTimeZone: captured.google_time_zone,
      currency: captured.currency,
      baselineCostMicros: captured.baseline_cost_micros,
      captureStartedAt: captured.capture_started_at,
      capturedAt: captured.captured_at,
      captureId: captured.capture_id,
      source: captured.source,
    },
  });
}
