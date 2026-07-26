import { NextResponse, type NextRequest } from "next/server";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { syncHstCommission } from "@/lib/admin/hst";

/**
 * Payments RECEIVED from HST.
 *
 * POST { amount, paidOn, coversThrough, notes? } → record one
 * DELETE ?id=…                                   → undo a mis-entry
 *
 * Recording a payment re-runs the commission sync, because a row's paid/unpaid
 * status is DERIVED from these rows (see migration 0012) — without the resync
 * the ledger would keep showing settled days as merely confirmed until the next
 * hourly run.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { amount?: number; paidOn?: string; coversThrough?: string; notes?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "Enter the amount HST paid." }, { status: 400 });
  }
  if (!body.coversThrough || !ISO_DAY.test(body.coversThrough)) {
    return NextResponse.json(
      { error: "Say which commission day this payment covers up to." },
      { status: 400 },
    );
  }
  const paidOn = body.paidOn && ISO_DAY.test(body.paidOn) ? body.paidOn : undefined;

  const supabase = await createClient();
  const { error } = await supabase.from("hst_payments").insert({
    amount,
    covers_through: body.coversThrough,
    ...(paidOn ? { paid_on: paidOn } : {}),
    notes: body.notes?.trim() || null,
    created_by: profile.id,
  });

  if (error) {
    const missing = error.message.includes("hst_payments");
    return NextResponse.json(
      {
        error: missing
          ? "The payments table doesn't exist yet — run migration 0012."
          : error.message,
      },
      { status: 500 },
    );
  }

  // Re-derive the ledger's paid/confirmed statuses right away.
  const resync = await syncHstCommission({ force: true });
  return NextResponse.json({ ok: true, resyncError: resync.ok ? null : resync.error });
}

export async function DELETE(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase.from("hst_payments").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const resync = await syncHstCommission({ force: true });
  return NextResponse.json({ ok: true, resyncError: resync.ok ? null : resync.error });
}
