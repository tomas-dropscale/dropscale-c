import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { readApifyToken } from "@/lib/research/apify-token";
import {
  cacheKey,
  MAX_GEOS,
  startCompareRun,
  type ComparePair,
} from "@/lib/research/compare";

export const dynamic = "force-dynamic";

/**
 * Start a joint-scale market comparison — the one research action that spends
 * money. A cached combination is returned instead of being re-run, and the
 * database row is claimed BEFORE Apify is called so two admins clicking at
 * once cannot buy the same comparison twice.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { id?: unknown; geos?: unknown; kws?: unknown; timeframe?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const geos = Array.isArray(body.geos)
    ? body.geos.filter((geo): geo is string => typeof geo === "string")
    : [];
  if (!id || geos.length < 2 || geos.length > MAX_GEOS) {
    return NextResponse.json(
      { error: `Pick between 2 and ${MAX_GEOS} markets.` },
      { status: 400 },
    );
  }

  const timeframe = typeof body.timeframe === "string" ? body.timeframe : undefined;
  const kws = (body.kws ?? {}) as Record<string, unknown>;
  const pairs: ComparePair[] = geos.map((geo) => ({
    geo,
    kw: typeof kws[geo] === "string" ? (kws[geo] as string) : "",
  }));
  if (pairs.some((pair) => !pair.kw)) {
    return NextResponse.json({ error: "A local keyword is missing." }, { status: 400 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  const key = await cacheKey(id, geos, timeframe);
  const { data: cached } = await supabase
    .from("research_comparisons")
    .select("status, payload, run_id")
    .eq("key", key)
    .maybeSingle();
  if (cached?.status === "done" && cached.payload) {
    return NextResponse.json({ cached: true, result: cached.payload });
  }
  // Someone already paid for this exact comparison and it is still running:
  // join their run rather than buying a second one.
  if (cached?.status === "running" && cached.run_id) {
    return NextResponse.json({ runId: cached.run_id }, { status: 202 });
  }

  const token = await readApifyToken();
  if (!token) {
    return NextResponse.json(
      { error: "No Apify token is saved. Add one above before running a comparison." },
      { status: 422 },
    );
  }

  // Claim the combination BEFORE spending. The primary key makes this atomic:
  // a racing request finds the row and joins the run instead of starting one.
  const { data: claimed, error: claimError } = await supabase
    .from("research_comparisons")
    .insert({
      key,
      concept_id: id,
      geos,
      pairs,
      status: "running",
      created_by: profile.id,
    })
    .select("key")
    .maybeSingle();
  if (claimError) {
    if (claimError.code === "23505") {
      const { data: winner } = await supabase
        .from("research_comparisons")
        .select("run_id, status, payload")
        .eq("key", key)
        .maybeSingle();
      if (winner?.status === "done" && winner.payload) {
        return NextResponse.json({ cached: true, result: winner.payload });
      }
      if (winner?.run_id) {
        return NextResponse.json({ runId: winner.run_id }, { status: 202 });
      }
    }
    return NextResponse.json(
      { error: `Could not claim the comparison: ${claimError.message}` },
      { status: 500 },
    );
  }
  if (!claimed) {
    return NextResponse.json(
      { error: "Could not claim the comparison; try again." },
      { status: 500 },
    );
  }

  let started: { runId: string; url: string };
  try {
    started = await startCompareRun(pairs, token, timeframe);
  } catch (error) {
    // Nothing was spent, so the claim must not block a retry.
    await supabase.from("research_comparisons").delete().eq("key", key);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Apify refused the run." },
      { status: 502 },
    );
  }

  const { error: saveError } = await supabase
    .from("research_comparisons")
    .update({ run_id: started.runId, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (saveError) {
    // The run is already paid for; surface its id so nothing is silently lost.
    console.error("Could not record the comparison run:", saveError.message);
  }

  return NextResponse.json({ runId: started.runId }, { status: 202 });
}
