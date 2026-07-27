import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  purgeAdminAccountRevenue,
  syncCommissionLedger,
  syncRevenueShareLedger,
} from "@/lib/admin/commission-sync";

/**
 * POST — book agency commission from Google NOW, ignoring the page-load throttle.
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

    return NextResponse.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Ledger sync failed:", error);
    return NextResponse.json({ error: "Could not sync the ledgers." }, { status: 500 });
  }
}
