import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  purgeAdminAccountRevenue,
  syncCommissionLedger,
  syncRevenueShareLedger,
} from "@/lib/admin/commission-sync";
import { syncHstCommission, type HstSyncResult } from "@/lib/admin/hst";
import {
  billingEvidenceIsReady,
  billingEvidenceReadyAt,
  closedWeeks,
  closedWeekStarting,
} from "@/lib/billing/weekly";

/**
 * POST — book every ledger NOW, ignoring the page-load throttles.
 *
 * One route, two callers, because they want exactly the same work done:
 *   · the "Sync now" button on the overview — an admin session authorises a
 *     server-role source read, but cannot write its own completion proof;
 *   · the hourly cron in custom-worker.ts — no session at all, so it carries
 *     CRON_SECRET and the sync gets the service-role client instead.
 *
 * The point of forcing is agreement: /admin/campaigns computes commission live
 * from Google on every render, while the overview reads the ledger. Without a
 * way to say "now", the two figures can only agree by luck.
 *
 * HST rides along here rather than having a cron of its own. It used to run ONLY
 * when a human opened /admin/hst, which meant the supplier's commission stopped
 * at whatever day the last visit happened to be — for weeks, silently, since
 * nothing about a stale figure looks any different from a correct one.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorised = secret ? request.headers.get("authorization") === `Bearer ${secret}` : false;

  // Cron path: no session, so it needs the key that bypasses RLS.
  if (authorised) {
    const supabase = createServiceClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
        { status: 503 },
      );
    }
    if (request.nextUrl.searchParams.get("billingWeek") === "latest") {
      const period = closedWeeks()[0];
      if (!period) {
        return NextResponse.json({ error: "No closed billing week is available." }, { status: 422 });
      }
      if (!billingEvidenceIsReady(period.end)) {
        return NextResponse.json(
          {
            error: "Google's Sunday spend is still inside the settling window.",
            readyAt: billingEvidenceReadyAt(period.end).toISOString(),
          },
          { status: 409 },
        );
      }
      // Monday's first machine step captures Google's latest available
      // snapshot for the just-closed Monday-to-Sunday week. The following
      // protected billing step may issue only after this proof is complete.
      return run({ force: true, client: supabase, period }, true);
    }
    return run({ force: true, client: supabase });
  }

  // Otherwise it must be an admin in a browser.
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  // Authentication is still the admin's browser session, but the source proof
  // is written by the server role. Admins may review or request a Google read;
  // they cannot manufacture a `complete` sync window through PostgREST.
  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { periodStart?: unknown }
    | null;
  if (body?.periodStart !== undefined) {
    if (typeof body.periodStart !== "string") {
      return NextResponse.json({ error: "periodStart must be a string." }, { status: 422 });
    }
    const period = closedWeekStarting(body.periodStart);
    if (!period) {
      return NextResponse.json(
        { error: "Select a fully closed Monday-to-Sunday billing week." },
        { status: 422 },
      );
    }
    if (!billingEvidenceIsReady(period.end)) {
      return NextResponse.json(
        {
          error:
            "Google's Sunday spend is still settling. Refresh this billing week after the evidence cutoff.",
          readyAt: billingEvidenceReadyAt(period.end).toISOString(),
        },
        { status: 409 },
      );
    }
    return run({ force: true, client: supabase, period }, true);
  }

  return run({ force: true, client: supabase });
}

async function run(
  opts: Parameters<typeof syncCommissionLedger>[0],
  billingOnly = false,
) {
  try {
    // Purge first: admin-owned stores are internal, and their spend must never
    // reach the ledger even for the instant between booking and cleanup.
    await purgeAdminAccountRevenue(opts);
    await syncCommissionLedger(opts);

    if (billingOnly) {
      return NextResponse.json({
        ok: true,
        period: opts?.period,
        syncedAt: new Date().toISOString(),
      });
    }

    await syncRevenueShareLedger(opts);

    // HST last, and never fatal: it hangs off a third-party ERP session that
    // expires, and a dead HST token must not stop Google's commission from
    // being booked. The outcome travels in the response instead, so the cron
    // log says WHY the supplier's number stopped moving — the previous failure
    // mode was that nobody found out at all.
    let hst: HstSyncResult;
    try {
      hst = await syncHstCommission({ ...opts, force: true });
    } catch (error) {
      hst = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!hst.ok) console.error("HST sync failed during ledger sync:", hst.error);

    // Manual referral terms never expire or reprice themselves. This refreshes
    // only the legacy `commission_rate` display cache when a scheduled sealed
    // term reaches its Monday in the Lisbon billing calendar. Historical
    // ledgers and invoices continue to resolve their own effective week.
    let referralRateCachesRefreshed: number | null = null;
    try {
      if (!opts?.client) throw new Error("Service client is required for referral cache refresh.");
      const { data, error } = await opts.client.rpc(
        "refresh_all_referral_rates",
      );
      if (error) throw error;
      referralRateCachesRefreshed = data ?? 0;
    } catch (error) {
      console.error("Manual referral cache refresh failed:", error);
    }

    return NextResponse.json({
      ok: true,
      syncedAt: new Date().toISOString(),
      hst,
      referralRateCachesRefreshed,
    });
  } catch (error) {
    console.error("Ledger sync failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not sync the ledgers.",
      },
      { status: 500 },
    );
  }
}
