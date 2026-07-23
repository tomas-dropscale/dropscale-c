import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/google-ads/crypto";
import { resyncAccountNow } from "@/lib/metrics/recompute";
import {
  isClientSecret,
  normalizeShopDomain,
  resolveAdminToken,
  validateShopifyCredentials,
  ShopifyError,
} from "@/lib/shopify/client";

/**
 * Connect / disconnect a store's Shopify custom app.
 *
 * POST { accountId, shopDomain, accessToken, clientId? }  → connect
 * DELETE ?accountId=...                                   → disconnect
 *
 * `accessToken` accepts either credential:
 *   shpat_… — a direct Admin API access token, used as-is;
 *   shpss_… — the app's API secret key, exchanged (client_credentials, with
 *             the Client ID) for a ~24h shpat_ on every use. The SECRET is
 *             what gets stored — it is the durable credential.
 *
 * Whatever was pasted is validated against Shopify end-to-end (exchange if
 * needed + a read-only shop query), encrypted (AES-GCM, same key as the
 * Google Ads tokens) and stored server-side. The response — and every later
 * read — carries only the last 4 characters. The write rides the caller's
 * session: RLS only lets them touch their own account.
 */

async function ownAccount(accountId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, account: null };

  // Pinned to the session's client_id explicitly — same zone rule as
  // lib/portal/data.ts, so an admin cannot connect someone else's store from
  // the portal by accident.
  const { data: account } = await supabase
    .from("ad_accounts")
    .select("id, client_id, status")
    .eq("id", accountId)
    .eq("client_id", user.id)
    .maybeSingle();

  return { supabase, account };
}

export async function POST(request: NextRequest) {
  let body: {
    accountId?: string;
    shopDomain?: string;
    accessToken?: string;
    clientId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const accountId = body.accountId?.trim();
  const accessToken = body.accessToken?.trim();
  const clientId = body.clientId?.trim() || null;
  const domain = normalizeShopDomain(body.shopDomain ?? "");

  if (!accountId || !accessToken || !domain) {
    return NextResponse.json(
      { error: "accountId, shopDomain (…myshopify.com) and accessToken are required." },
      { status: 400 },
    );
  }

  if (isClientSecret(accessToken) && !clientId) {
    return NextResponse.json(
      { error: "An API secret key (shpss_…) also needs the app's Client ID (API key)." },
      { status: 400 },
    );
  }

  // Fail BEFORE talking to Shopify: without the server-side encryption key
  // there is nowhere safe to put the secret, and dying after a successful
  // validation produces a bare 500 that looks like a credentials problem.
  if (!process.env.GOOGLE_ADS_TOKEN_ENC_KEY) {
    return NextResponse.json(
      {
        error:
          "This server has no encryption key configured, so credentials cannot be stored. " +
          "On Cloudflare it is already set; for local dev copy GOOGLE_ADS_TOKEN_ENC_KEY into .env.local.",
      },
      { status: 503 },
    );
  }

  const { supabase, account } = await ownAccount(accountId);
  if (!account) {
    // Not signed in, or not their account — indistinguishable on purpose.
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  let shop;
  try {
    // Secrets go through the client_credentials exchange first; the shop
    // query then proves the resulting token actually reads the Admin API.
    const headerToken = await resolveAdminToken(domain, accessToken, clientId);
    shop = await validateShopifyCredentials(domain, headerToken);
  } catch (error) {
    const message =
      error instanceof ShopifyError
        ? error.status === 401 || error.status === 403
          ? isClientSecret(accessToken)
            ? error.message // exchange errors already say exactly what's wrong
            : "Shopify rejected this token. If you pasted the shpss_ secret, fill in the Client ID too — or paste the shpat_ Admin API access token instead."
          : error.message
        : "Could not reach Shopify with these details. Check the store URL.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  // Sales come from the orders API. The base scope is read_orders (or
  // write_orders, which implies it); read_all_orders ALONE does not grant the
  // orders field — it is only the ">60 days" extension on top of read_orders,
  // and without the base the query fails with ACCESS_DENIED. Learned the hard
  // way: a shop with read_all_orders + read_analytics and no read_orders
  // passed the old check and then couldn't sync. (An empty scope list means
  // the shop didn't report them — proceed rather than false-positive.)
  const hasOrdersScope =
    shop.accessScopes.includes("read_orders") || shop.accessScopes.includes("write_orders");
  if (shop.accessScopes.length > 0 && !hasOrdersScope) {
    return NextResponse.json(
      {
        error:
          "The app is missing the read_orders scope, so revenue can't sync — and note that " +
          "read_all_orders alone does NOT include it. In the app's Configuration → Admin API " +
          "integration, enable read_orders (keep read_all_orders for history beyond 60 days), " +
          "save, install/update the app, then connect again.",
      },
      { status: 422 },
    );
  }

  const { error: updateError } = await supabase
    .from("ad_accounts")
    .update({
      shopify_url: shop.myshopifyDomain,
      // account.currency stays the REPORTING currency (EUR by default) — the
      // store's base currency (shop.currencyCode) may differ, and the sync
      // converts order amounts into the reporting currency with daily ECB
      // rates (lib/shopify/fx.ts). Overwriting it here would flip the whole
      // dashboard into the store's local currency instead.
      shopify_client_id: clientId,
      shopify_scopes: shop.accessScopes.join(", ") || null,
      shopify_admin_token: await encryptToken(accessToken),
      shopify_token_last4: accessToken.slice(-4),
      shopify_connected: true,
      shopify_connected_at: new Date().toISOString(),
    })
    .eq("id", accountId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Pull the store's history right away. Waiting for the lazy sync would show
  // a connected store with an empty dashboard — the per-account throttle and
  // coverage checks don't know a NEW source just appeared. Pending accounts
  // are the exception: approval is the gate, so nothing syncs yet.
  let syncWarning: string | null = null;
  if (account.status === "pending") {
    syncWarning =
      "Connected. Data will start syncing once the Dropscale team approves this account.";
  } else {
    try {
      await resyncAccountNow(accountId);
    } catch (error) {
      console.error(`Post-connect resync failed for ${accountId}:`, error);
      syncWarning =
        "Connected, but the first data sync failed — the dashboard will retry within 15 minutes. " +
        (error instanceof Error ? error.message : "");
    }
  }

  return NextResponse.json({
    connected: true,
    shopName: shop.name,
    currency: shop.currencyCode,
    domain: shop.myshopifyDomain,
    tokenLast4: accessToken.slice(-4),
    syncWarning,
  });
}

export async function DELETE(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId")?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required." }, { status: 400 });
  }

  const { supabase, account } = await ownAccount(accountId);
  if (!account) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const { error: updateError } = await supabase
    .from("ad_accounts")
    .update({
      shopify_admin_token: null,
      shopify_token_last4: null,
      shopify_connected: false,
      shopify_connected_at: null,
    })
    .eq("id", accountId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ connected: false });
}
