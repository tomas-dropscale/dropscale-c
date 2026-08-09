import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { readApifyToken } from "@/lib/research/apify-token";
import { pollCompareRun, type ComparePair } from "@/lib/research/compare";

export const dynamic = "force-dynamic";

/**
 * Where a comparison run stands. The Worker keeps no job in memory between
 * requests, so this reads the recorded run, asks Apify, and finishes the work
 * (building and caching the joint-scale series) the first time it succeeds.
 */
export async function GET(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ state: "unknown" });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { state: "error", error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  const { data: row } = await supabase
    .from("research_comparisons")
    .select("key, concept_id, geos, pairs, status, payload, error")
    .eq("run_id", runId)
    .maybeSingle();
  if (!row) return NextResponse.json({ state: "unknown" });
  if (row.status === "done" && row.payload) {
    return NextResponse.json({ state: "done", result: row.payload });
  }
  if (row.status === "error") {
    return NextResponse.json({ state: "error", error: row.error });
  }

  const token = await readApifyToken();
  if (!token) {
    return NextResponse.json({ state: "error", error: "No Apify token is saved." });
  }

  const pairs = row.pairs as ComparePair[];
  let progress;
  try {
    progress = await pollCompareRun(runId, pairs, token);
  } catch (error) {
    return NextResponse.json({
      state: "error",
      error: error instanceof Error ? error.message : "Apify could not be reached.",
    });
  }

  if (progress.state === "running") return NextResponse.json({ state: "running" });

  if (progress.state === "error") {
    await supabase
      .from("research_comparisons")
      .update({ status: "error", error: progress.error, updated_at: new Date().toISOString() })
      .eq("key", row.key);
    return NextResponse.json({ state: "error", error: progress.error });
  }

  const result = {
    id: row.concept_id,
    geos: row.geos,
    key: row.key,
    runId,
    costUsd: progress.costUsd,
    generated: new Date().toISOString().slice(0, 10),
    scale: "joint — the series are comparable to each other (global max = 100)",
    series: progress.series,
  };
  await supabase
    .from("research_comparisons")
    .update({
      status: "done",
      payload: result,
      cost_usd: progress.costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq("key", row.key);

  return NextResponse.json({ state: "done", result });
}
