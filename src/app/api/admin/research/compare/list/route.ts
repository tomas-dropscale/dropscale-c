import { NextResponse } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** Comparisons already paid for, so the tool can offer them for free. */
export async function GET() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const supabase = createServiceClient();
  if (!supabase) return NextResponse.json([]);

  const { data } = await supabase
    .from("research_comparisons")
    .select("key, concept_id, geos, cost_usd, updated_at")
    .eq("status", "done")
    .order("updated_at", { ascending: false })
    .limit(100);

  return NextResponse.json(
    (data ?? []).map((row) => ({
      key: row.key,
      id: row.concept_id,
      geos: row.geos,
      costUsd: row.cost_usd,
      generated: String(row.updated_at).slice(0, 10),
    })),
  );
}
