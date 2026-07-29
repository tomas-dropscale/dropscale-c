import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  purgeAdminAccountRevenue,
  syncCommissionLedger,
  syncRevenueShareLedger,
} from "@/lib/admin/commission-sync";
import { syncHstCommission, type HstSyncResult } from "@/lib/admin/hst";

/**
 * POST — book every ledger NOW, ignoring the page-load throttles.
 *
 * One route, two callers, because they want exactly the same work done:
 *   · the "Sync now" button on the overview — an admin session, so the sync
 *     rides their own RLS like any page load does;
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
    return run({ force: true, client: supabase });
  }

  // Otherwise it must be an admin in a browser.
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return run({ force: true });
}

async function run(opts: Parameters<typeof syncCommissionLedger>[0]) {
  try {
    // Purge first: admin-owned stores are internal, and their spend must never
    // reach the ledger even for the instant between booking and cleanup.
    await purgeAdminAccountRevenue(opts);
    await syncCommissionLedger(opts);
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

    return NextResponse.json({ ok: true, syncedAt: new Date().toISOString(), hst });
  } catch (error) {
    console.error("Ledger sync failed:", error);
    return NextResponse.json({ error: "Could not sync the ledgers." }, { status: 500 });
  }
}
