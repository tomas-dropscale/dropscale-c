import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { syncHstCommission } from "@/lib/admin/hst";

/** POST — pull HST commission now and book it into the ledger. Admin only. */
export async function POST() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const result = await syncHstCommission({ force: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
