import { NextResponse, type NextRequest } from "next/server";

import { captureGoogleBillingStartAsAgency } from "@/lib/google-ads/billing-start";
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
  let requestClientId: string | null = null;
  let accountStatus: string | null = null;

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
    accountStatus = account.status;
  } else {
    const { data: accountRequest, error } = await session
      .from("account_requests")
      .select("id, client_id, request_type, google_ads_customer_id, store_name, status")
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
    requestClientId = accountRequest.client_id;
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
    captured = await captureGoogleBillingStartAsAgency(googleAdsCustomerId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Google Ads error";
    console.error("Google billing-start capture failed:", {
      targetKind: target.kind,
      targetId: target.id,
      message: detail,
    });

    if (/CUSTOMER_NOT_FOUND/.test(detail)) {
      return NextResponse.json(
        {
          error: `Google says customer ${googleAdsCustomerId} does not exist. Fix the customer ID and verify again; nothing was accepted.`,
        },
        { status: 422 },
      );
    }

    if (/PERMISSION_DENIED/.test(detail)) {
      // The opening Google counter is AGENCY-captured evidence: the billing
      // start row is constrained to source='agency', and the database refuses
      // to make an account billable without one. A missing grant therefore
      // cannot be accepted around — an earlier attempt to flip the account to
      // active regardless was rejected by that invariant and surfaced as a
      // meaningless "the account changed" error.
      //
      // Google also answers PERMISSION_DENIED for agency-side misconfiguration
      // (wrong login-customer-id, unapproved developer token), so the message
      // names both remediations rather than blaming the client outright.
      const grantAccess =
        `Google refused access to customer ${googleAdsCustomerId}. ` +
        "Add the agency as a manager of that account in Google Ads " +
        "(Admin \u2192 Access and security) \u2014 or, if other accounts verify " +
        "fine, check the agency's own Google Ads access \u2014 then verify again.";

      if (target.kind === "account") {
        // Nothing is mutated: the account keeps whatever status it already
        // has, and saying which one is what tells the admin where to find it.
        const placement =
          accountStatus === "pending"
            ? "The store stays pending and keeps its place in the list"
            : "The store stays connected but unbilled until its opening counter is captured";
        return NextResponse.json(
          { error: `${grantAccess} ${placement} \u2014 nothing was lost.` },
          { status: 502 },
        );
      }

      if (!requestClientId) {
        return NextResponse.json(
          { error: "The account request is missing its client; nothing was accepted." },
          { status: 500 },
        );
      }

      // Idempotent by customer id: ad_accounts_google_customer_uq makes a
      // blind insert fail with a raw constraint error on any retry, and a
      // retry is exactly what an admin does after a half-completed attempt.
      const { data: existingAccount, error: existingError } = await service
        .from("ad_accounts")
        .select("id, store_name, status")
        .eq("google_ads_customer_id", googleAdsCustomerId)
        .maybeSingle();
      if (existingError) {
        return NextResponse.json(
          { error: `Could not check for an existing store: ${existingError.message}` },
          { status: 500 },
        );
      }

      let account = existingAccount;
      if (!account) {
        const { data: createdAccount, error: createError } = await service
          .from("ad_accounts")
          .insert({
            client_id: requestClientId,
            store_name: storeName,
            google_ads_customer_id: googleAdsCustomerId,
            // Pending is the only status the database accepts for an account
            // with no committed billing start, and it is the honest one: the
            // store exists and the client can see it, but it is not billable.
            status: "pending",
            currency: "EUR",
            list_commission_rate: 10,
            revenue_share_enabled: false,
          })
          .select("id, store_name, status")
          .maybeSingle();
        if (createError || !createdAccount) {
          return NextResponse.json(
            { error: createError?.message ?? "Could not create the ad account." },
            { status: 500 },
          );
        }
        account = createdAccount;
      }

      // Approve LAST and report its failure: leaving the request pending while
      // the account exists is a half-state the admin has to know about, and a
      // green banner over it would send them into a duplicate retry.
      const { error: approveError } = await service
        .from("account_requests")
        .update({ status: "approved" })
        .eq("id", target.id)
        .eq("status", "pending");
      if (approveError) {
        console.error("Account request approval failed after acceptance:", {
          requestId: target.id,
          message: approveError.message,
        });
        return NextResponse.json(
          {
            error:
              `The store was created as pending, but its request could not be closed: ${approveError.message}. ` +
              "Verify again to finish it; the store will not be duplicated.",
          },
          { status: 500 },
        );
      }

      return NextResponse.json({
        ok: true,
        deferred: true,
        account: {
          id: account.id,
          storeName: account.store_name || storeName,
          status: account.status,
        },
        message: grantAccess,
      });
    }

    return NextResponse.json(
      {
        error:
          "Google Ads could not verify this account. Confirm the agency has access and try again; tracking has not started.",
      },
      { status: 502 },
    );
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
