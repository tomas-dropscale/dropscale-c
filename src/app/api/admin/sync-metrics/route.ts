import { NextResponse, type NextRequest } from "next/server";

import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { recomputeDailyMetrics } from "@/lib/metrics/recompute";
import type { AdAccount } from "@/lib/supabase/types";

/**
 * How many accounts one run recomputes. Each costs several Google/Shopify
 * subrequests; five keeps the run inside the Workers Free 50-subrequest
 * budget. The stalest-first rotation converges over the fleet across runs.
 */
const MAX_ACCOUNTS_PER_RUN = 5;

/**
 * POST — close the day: pull every account's Google spend and Shopify revenue
 * into `daily_metrics` now, ignoring the 15-minute throttle.
 *
 * Runs at 23:55 so the day is complete before it rolls over. Until this
 * existed, `daily_metrics` was only ever written when someone opened a page
 * that read it — which means a client who never logs in had no numbers, and
 * the admin report showed their revenue as zero. Ledger sync (the hourly cron)
 * does not cover this: it reads Google directly and never touches the rollup
 * the reports are built on.
 *
 * Admin session or CRON_SECRET, same as the ledger route. The cron has no
 * session, so it gets the service-role client — writing `daily_metrics`
 * requires owning the account or being an admin.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorised = secret ? request.headers.get("authorization") === `Bearer ${secret}` : false;

  const supabase = authorised ? createServiceClient() : null;

  if (authorised && !supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  if (!authorised) {
    const { profile } = await getSessionProfile();
    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
  }

  try {
    // The cron's service client, or the admin's own session.
    const db = supabase ?? (await createClient());

    // Every account is eligible, but the Workers Free plan caps an invocation
    // at 50 external subrequests — a full-fleet recompute no longer fits. Each
    // run therefore takes the stalest accounts and lets the hourly cron rotate
    // through the rest, a durable queue ordered by last recompute.
    const { data } = await db.from("ad_accounts").select("*");
    const accounts = (data as AdAccount[] | null) ?? [];

    const { data: recentMetrics } = await db
      .from("daily_metrics")
      .select("ad_account_id, computed_at")
      .order("computed_at", { ascending: false })
      .limit(500);
    const lastComputeByAccount = new Map<string, string>();
    for (const row of recentMetrics ?? []) {
      if (!lastComputeByAccount.has(row.ad_account_id)) {
        lastComputeByAccount.set(row.ad_account_id, row.computed_at);
      }
    }
    const batch = [...accounts]
      .sort((left, right) =>
        (lastComputeByAccount.get(left.id) ?? "").localeCompare(
          lastComputeByAccount.get(right.id) ?? "",
        ),
      )
      .slice(0, MAX_ACCOUNTS_PER_RUN);

    await recomputeDailyMetrics(batch, { force: true, client: db });

    return NextResponse.json({
      ok: true,
      accounts: batch.length,
      queued: accounts.length - batch.length,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Daily metrics close failed:", error);
    return NextResponse.json({ error: "Could not refresh the metrics." }, { status: 500 });
  }
}
