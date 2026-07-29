import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { ensureWeeklyInvoices } from "@/lib/billing/invoices";

/**
 * POST — run the weekly invoice generation now. Admin only.
 *
 * `{"billBacklog": true}` also releases weeks older than AUTO_BILL_WEEKS, which
 * an ordinary run records but refuses to send. That is the whole point of the
 * flag: back-invoicing a client several weeks at once is a decision someone
 * makes, never something a page load or a cron does on its own.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { billBacklog?: boolean } | null;

  const result = await ensureWeeklyInvoices({
    force: true,
    billBacklog: body?.billBacklog === true,
  });
  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}
