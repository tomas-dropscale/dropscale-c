import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { syncHstCosts } from "@/lib/admin/hst-cost-sync";

/**
 * POST — pull one store's supplier costs now, instead of waiting for the hour.
 *
 * Worth a button of its own because the answer is not "ok". Whoever just typed
 * a supplier code needs to know whether it was the right one, and the only
 * proof of that is what came back: products priced, orders charged, and how
 * many supplier lines named a product this store has never sold — the number
 * that says "right shop, wrong store" when everything else looks fine.
 *
 * `sinceDays` widens the window for a first pull, where three days of orders
 * would price only a handful of products.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { adAccountId?: unknown; sinceDays?: unknown }
    | null;

  const adAccountId = typeof body?.adAccountId === "string" ? body.adAccountId.trim() : "";
  if (!adAccountId) {
    return NextResponse.json({ error: "Send the store's id." }, { status: 422 });
  }

  const sinceDays =
    typeof body?.sinceDays === "number" && Number.isFinite(body.sinceDays)
      ? Math.min(90, Math.max(1, Math.floor(body.sinceDays)))
      : undefined;

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  const result = await syncHstCosts({
    client: service,
    adAccountIds: [adAccountId],
    sinceDays,
  });

  if (result.accounts === 0) {
    return NextResponse.json(
      { error: "This store has no supplier code yet — save one first." },
      { status: 422 },
    );
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
