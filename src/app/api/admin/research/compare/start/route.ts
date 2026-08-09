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
 * money. A cached combination is returned instead of being re-run.
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

  const key = await cacheKey(id, geos);
  const { data: cached } = await supabase
    .from("research_comparisons")
    .select("status, payload")
    .eq("key", key)
    .maybeSingle();
  if (cached?.status === "done" && cached.payload) {
    return NextResponse.json({ cached: true, result: cached.payload });
  }

  const token = await readApifyToken();
  if (!token) {
    return NextResponse.json(
      { error: "No Apify token is saved. Add one above before running a comparison." },
      { status: 422 },
    );
  }

  let started: { runId: string; url: string };
  try {
    started = await startCompareRun(
      pairs,
      token,
      typeof body.timeframe === "string" ? body.timeframe : undefined,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Apify refused the run." },
      { status: 502 },
    );
  }

  const { error: saveError } = await supabase.from("research_comparisons").upsert(
    {
      key,
      concept_id: id,
      geos,
      run_id: started.runId,
      pairs,
      status: "running",
      payload: null,
      error: null,
      created_by: profile.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (saveError) {
    // The run is already paid for; surface its id so nothing is silently lost.
    console.error("Could not record the comparison run:", saveError.message);
  }

  return NextResponse.json({ runId: started.runId }, { status: 202 });
}
