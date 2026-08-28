import { NextResponse, type NextRequest } from "next/server";

import { mayManageStoreSupplier } from "@/lib/portal/hst-store-access";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchHstStoreOrders } from "@/lib/admin/hst-cost-sync";

/**
 * POST — this store's recent orders as the supplier bills them, for the
 * per-order view on the Costs page.
 *
 * Read live on purpose. The cost sync already persists what the books need
 * (per-product costs and the per-order tariff); this is a look at the supplier's
 * own order list, goods and import duty kept apart, and it is never stored. A
 * failure is the supplier's to explain — the message travels back so the panel
 * can say "couldn't reach HST" rather than showing an empty table as if there
 * were nothing to bill.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { adAccountId?: unknown; limit?: unknown }
    | null;

  const adAccountId = typeof body?.adAccountId === "string" ? body.adAccountId.trim() : "";
  if (!adAccountId) {
    return NextResponse.json({ error: "Send the store's id." }, { status: 422 });
  }
  if (!(await mayManageStoreSupplier(adAccountId))) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const limit =
    typeof body?.limit === "number" && Number.isFinite(body.limit)
      ? Math.min(120, Math.max(1, Math.floor(body.limit)))
      : undefined;

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  try {
    const orders = await fetchHstStoreOrders({ service, adAccountId, limit });
    return NextResponse.json({ orders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Couldn't load your HST orders." },
      { status: 502 },
    );
  }
}
