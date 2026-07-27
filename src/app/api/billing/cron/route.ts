import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ensureWeeklyInvoices, reconcileInvoices } from "@/lib/billing/invoices";

/**
 * The Monday billing run.
 *
 * Called by the Cloudflare cron trigger in custom-worker.ts, which invokes this
 * worker's own fetch handler — no public round trip. It is still a real, PUBLIC
 * route, so the bearer secret is what stands between the internet and a billing
 * run; without CRON_SECRET set it refuses to run at all rather than falling
 * open.
 *
 * Runs with the SERVICE ROLE, because a cron has no session and both the
 * commission ledger it reads and the invoices it writes are admin-only under
 * RLS. This is the second and last caller entitled to that key, alongside the
 * Stripe webhook.
 *
 * Everything underneath is idempotent — (client_id, period_start) plus Stripe
 * idempotency keys — so a retried or double-fired cron cannot double-bill.
 */

export const dynamic = "force-dynamic";

async function run(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("authorization");
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  // force: the per-isolate throttle exists to keep page loads cheap, and would
  // otherwise let a cron fire that does nothing.
  const result = await ensureWeeklyInvoices({ force: true, client: supabase });

  // Catch up on anything Stripe settled while we weren't listening — the
  // webhook may have been down, or may not be configured yet.
  await reconcileInvoices(supabase);

  return NextResponse.json({
    ok: result.errors.length === 0,
    ranAt: new Date().toISOString(),
    ...result,
  });
}

export async function POST(request: NextRequest) {
  return run(request);
}

/**
 * GET behaves identically. Cloudflare's cron always sends the request this
 * worker builds for it, but an operator debugging a missed Monday reaches for
 * curl, and the secret is what authorises either way.
 */
export async function GET(request: NextRequest) {
  return run(request);
}
