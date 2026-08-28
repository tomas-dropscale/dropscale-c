import { NextResponse, type NextRequest } from "next/server";

import { mayManageStoreSupplier } from "@/lib/portal/hst-store-access";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST — say which HST shop a store is, or that it is not one.
 *
 * This mapping is the entire opt-in for automatic supplier COGS. One HST login
 * sees every shop the agency buys through, so without a deliberate answer here
 * there is no safe way to tell which of them is this client's — and a wrong
 * guess writes another client's costs onto their products, silently and with
 * every number still looking plausible.
 *
 * Sending null unmaps a store, which stops the sync for it and leaves whatever
 * costs were already written exactly where they are. They are dated facts; the
 * client can edit them from here on, as they could before.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { adAccountId?: unknown; shopId?: unknown }
    | null;

  const adAccountId = typeof body?.adAccountId === "string" ? body.adAccountId.trim() : "";
  if (!adAccountId) {
    return NextResponse.json({ error: "Send the store's id." }, { status: 422 });
  }
  if (!(await mayManageStoreSupplier(adAccountId))) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (body?.shopId !== null && typeof body?.shopId !== "string") {
    return NextResponse.json(
      { error: "Send shopId as text, or null to stop syncing this store." },
      { status: 422 },
    );
  }

  // Mirrors the column's own constraint in 0087, so an unusable value is
  // refused with a sentence instead of a database error.
  const shopId = body.shopId === null ? null : body.shopId.trim();
  if (shopId !== null && (shopId.length < 1 || shopId.length > 64 || /[\p{Cc}]/u.test(shopId))) {
    return NextResponse.json({ error: "That shop id can't be used." }, { status: 422 });
  }

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  const { data, error } = await service
    .from("ad_accounts")
    .update({ hst_shop_id: shopId })
    .eq("id", adAccountId)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json({ error: "Store not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, adAccountId, shopId });
}
