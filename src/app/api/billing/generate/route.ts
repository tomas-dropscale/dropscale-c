import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { ensureWeeklyInvoices } from "@/lib/billing/invoices";

/** POST — run the weekly invoice generation now. Admin only. */
export async function POST() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const result = await ensureWeeklyInvoices({ force: true });
  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}
