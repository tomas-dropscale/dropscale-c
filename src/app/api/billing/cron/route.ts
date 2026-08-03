import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { reconcileInvoices } from "@/lib/billing/invoices";

/**
 * Stripe-state reconciliation safety net. Automatic legacy issuance is paused
 * while the reviewed manual-billing cutover is prepared. This route never
 * calculates, creates, finalises or sends a new invoice.
 */

export const dynamic = "force-dynamic";

async function run(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  await reconcileInvoices(supabase);
  return NextResponse.json({ ok: true, ranAt: new Date().toISOString() });
}

export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}
