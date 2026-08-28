import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { HstError, hstAccessToken } from "./hst";
import { applyHstCosts, type HstOrderCost } from "./hst-costs";
import { parseHstOrderPage, type HstShop } from "./hst-orders";
import type { Database } from "@/lib/supabase/types";

/**
 * COGS that arrive by themselves, for the stores HST supplies.
 *
 * The supplier's Order List already carries what every line cost and what the
 * import tariff was. This walks it, newest first, for each store that has been
 * mapped to an HST shop, and hands the result to applyHstCosts — which owns
 * what gets written and what is left alone.
 *
 * Nothing here runs for a store that has not been mapped. `hst_shop_id` is the
 * whole opt-in: one HST login sees ten shops, and guessing which one a client
 * is would write another client's costs onto their products.
 */

type Supabase = SupabaseClient<Database>;

const ORDERS_URL = "https://hsterp.com/orders";
/** The ERP's own list uses 12; it accepts more, and fewer round trips is fewer chances to fail. */
const PAGE_SIZE = 100;
/** A malformed or unfiltered response must not page forever. */
const MAX_PAGES = 30;
/**
 * How far back each run looks.
 *
 * Short on purpose. The list is newest-first and the run is hourly, so a narrow
 * window is enough to catch every order quoted since the last one — the ERP
 * logs show a quote landing within the hour an order arrives. Tariffs already
 * written stay written, so the record fills in as it goes rather than being
 * re-fetched. `sinceDays` widens it for a deliberate backfill.
 */
const DEFAULT_SINCE_DAYS = 3;

export type HstCostSyncResult = {
  ok: boolean;
  /** Stores mapped to an HST shop. Zero is a valid, quiet outcome. */
  accounts: number;
  written: number;
  unchanged: number;
  unknownProducts: number;
  charges: number;
  /** Supplier lines still awaiting a quote — skipped, never priced at zero. */
  unquotedLines: number;
  pages: number;
  error?: string;
  /** Per store, so a single broken mapping is legible in the cron log. */
  stores: Array<{
    adAccountId: string;
    shopId: string;
    written: number;
    unknownProducts: number;
    charges: number;
    error?: string;
  }>;
};

function emptyResult(): HstCostSyncResult {
  return {
    ok: true,
    accounts: 0,
    written: 0,
    unchanged: 0,
    unknownProducts: 0,
    charges: 0,
    unquotedLines: 0,
    pages: 0,
    stores: [],
  };
}

async function fetchOrdersPage(token: string, shopId: string, page: number): Promise<unknown> {
  // `shopIds` is the filter name the commission endpoint on this same ERP
  // takes. Correctness does not rest on it: every row is checked against the
  // shop id after parsing, so the parameter being ignored costs pages, not
  // accuracy.
  const url =
    `${ORDERS_URL}?search_field=platformOrderId` +
    `&shopIds=${encodeURIComponent(shopId)}&page=${page}&limit=${PAGE_SIZE}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      lang: "en",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new HstError("HST rejected the token — the session likely expired.", true);
  }
  if (!res.ok) throw new HstError(`HST returned ${res.status} for the order list.`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new HstError(
      `HST answered ${ORDERS_URL} with "${contentType || "no content-type"}" instead of JSON.`,
    );
  }
  return res.json();
}

/**
 * Every order for one shop back to `since`, newest first.
 *
 * Stops at the first page whose oldest order predates the window rather than
 * reading to the end of a 221-page list, and reports the shops it saw so the
 * admin picker has something to offer without a second request.
 */
async function collectOrders(
  token: string,
  shopId: string,
  timeZone: string,
  since: Date,
): Promise<{ orders: HstOrderCost[]; shops: HstShop[]; pages: number; unquotedLines: number }> {
  const orders: HstOrderCost[] = [];
  let shops: HstShop[] = [];
  let pages = 0;
  let unquotedLines = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await fetchOrdersPage(token, shopId, page);
    const parsed = parseHstOrderPage(payload, { shopId, timeZone });
    pages += 1;
    if (parsed.shops.length > 0) shops = parsed.shops;
    unquotedLines += parsed.unquotedLines;

    for (const order of parsed.orders) {
      if (new Date(order.paidAt) >= since) orders.push(order);
    }

    const oldest = parsed.oldestPaidAt ? new Date(parsed.oldestPaidAt) : null;
    // A page with nothing readable on it is the end of anything useful; one
    // that reached past the window means the next page is older still.
    if (!oldest || oldest < since) break;
    if (page >= parsed.lastPage) break;
  }

  return { orders, shops, pages, unquotedLines };
}

/**
 * Pull supplier costs for every mapped store.
 *
 * Never throws: the caller is an hourly cron whose other work must not be lost
 * because a third-party ERP session expired. Failures travel in the result so
 * the log says which store stopped and why — a sync that reports "ok" over
 * nothing is the failure mode this whole integration was already bitten by.
 */
export async function syncHstCosts(opts?: {
  client?: Supabase;
  sinceDays?: number;
  /** Overrides the day-attribution zone; see hst_order_charges.paid_at in 0087. */
  timeZone?: string;
  now?: Date;
}): Promise<HstCostSyncResult> {
  const result = emptyResult();
  const supabase = opts?.client ?? (await createClient());
  const now = opts?.now ?? new Date();
  const sinceDays = Math.max(1, Math.floor(opts?.sinceDays ?? DEFAULT_SINCE_DAYS));
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  // The store's own calendar is what an order day means, and it is Shopify
  // that knows it. Until it is stored, UTC is the neutral choice and the
  // instant is kept alongside so the day can be corrected without re-fetching.
  const timeZone = opts?.timeZone ?? "UTC";

  const { data: accounts, error: accountsError } = await supabase
    .from("ad_accounts")
    .select("id, hst_shop_id")
    .not("hst_shop_id", "is", null);
  if (accountsError) {
    return { ...result, ok: false, error: accountsError.message };
  }

  const mapped = ((accounts ?? []) as Array<{ id: string; hst_shop_id: string | null }>).filter(
    (row): row is { id: string; hst_shop_id: string } => !!row.hst_shop_id,
  );
  result.accounts = mapped.length;
  if (mapped.length === 0) return result;

  let token: string;
  try {
    token = await hstAccessToken(supabase);
  } catch (error) {
    return {
      ...result,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let renewed = false;
  for (const account of mapped) {
    const store = {
      adAccountId: account.id,
      shopId: account.hst_shop_id,
      written: 0,
      unknownProducts: 0,
      charges: 0,
    } as HstCostSyncResult["stores"][number];

    try {
      let collected;
      try {
        collected = await collectOrders(token, account.hst_shop_id, timeZone, since);
      } catch (error) {
        // One retry on a refusal, and only one: the second store must not pay
        // for the first one's expired session, and a renewal that does not help
        // would otherwise be attempted once per store.
        if (!(error instanceof HstError) || !error.unauthorized || renewed) throw error;
        renewed = true;
        token = await hstAccessToken(supabase, { forceRenew: true });
        collected = await collectOrders(token, account.hst_shop_id, timeZone, since);
      }

      result.pages += collected.pages;
      result.unquotedLines += collected.unquotedLines;

      const outcome = await applyHstCosts({
        service: supabase,
        adAccountId: account.id,
        orders: collected.orders,
        now,
      });

      store.written = outcome.written;
      store.unknownProducts = outcome.unknownProducts;
      store.charges = outcome.charges;
      result.written += outcome.written;
      result.unchanged += outcome.unchanged;
      result.unknownProducts += outcome.unknownProducts;
      result.charges += outcome.charges;
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.error = result.error ?? store.error;
    }

    result.stores.push(store);
  }

  return result;
}

/**
 * The shops this HST login can see, for mapping a store to one.
 *
 * The list rides on the order list's own response, so asking costs a single
 * page and never needs a shop to be mapped first — which is what makes the
 * mapping possible at all.
 */
export async function fetchHstShops(opts?: { client?: Supabase }): Promise<HstShop[]> {
  const supabase = opts?.client ?? (await createClient());
  const token = await hstAccessToken(supabase);
  // Any shop id works here; the response carries the whole list regardless.
  const payload = await fetchOrdersPage(token, "", 1);
  return parseHstOrderPage(payload, { shopId: "", timeZone: "UTC" }).shops;
}
