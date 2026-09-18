import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { HstError, hstGet } from "@/lib/hst/erp";
import { clientHstToken, noteClientHstError, storeHstShops } from "@/lib/portal/client-hst";
import { applyHstCosts, type HstOrderCost } from "./hst-costs";
import { decideFamilies, parseHstOrderPage, type HstShop } from "./hst-orders";
import { parseHstOrderDisplay, type HstOrderDisplay } from "./hst-order-display";
import type { Database } from "@/lib/supabase/types";

/**
 * COGS that arrive by themselves, for the stores their owner buys from HST.
 *
 * The supplier's Order List already carries what every line cost and what the
 * import tariff was. This walks it, newest first, and hands the result to
 * applyHstCosts — which owns what gets written and what is left alone.
 *
 * Two conditions, and both belong to the client. Their own HST session, because
 * a supplier account sees its owner's shop and nobody else's; and a supplier
 * code on the store, because one HST login can still see several shops and
 * guessing between them would write one store's costs onto another's products.
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
/**
 * Ten days, not three. The ERP reprices an order after quoting it — the
 * import tariff lands an hour to nearly three days after the first cost
 * (measured 2026-09-18 on Elena Granada: 31 of 64 orders moved, all upward)
 * — and a three-day window read each order once and never again, so the
 * reprice never landed. The list is newest-first by payment day, so ten days
 * is a page for a small store and four or five for one shipping thirty a day.
 */
const DEFAULT_SINCE_DAYS = 10;
/**
 * How far back an order the supplier has not priced yet keeps being re-read,
 * and how far back the rollup is refreshed after a cost sync so a late quote
 * reaches the P&L. Thirty days: the longest wait measured was 29 (a package
 * "Pending Similar Item Confirmation" from 2026-08-29 into September), and a
 * cap short of the tail turns a wait into a permanent hole. Beyond it the
 * store's own Sync now reaches ninety.
 */
export const HST_COST_REACH_DAYS = 30;

export type HstCostSyncResult = {
  ok: boolean;
  /** Stores with both a connected owner and a supplier code. */
  accounts: number;
  written: number;
  unchanged: number;
  unknownProducts: number;
  charges: number;
  /** Supplier lines still awaiting a quote — skipped, never priced at zero. */
  unquotedLines: number;
  pages: number;
  /**
   * The earliest day any store's window reached back to (ISO), so the rollup
   * can be refreshed exactly that far; null when nothing was read.
   */
  since: string | null;
  error?: string;
  /** Per store, so one broken connection is legible in the cron log. */
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
    since: null,
    stores: [],
  };
}

/**
 * The shop list alone, in the smallest page the ERP will answer.
 *
 * The list rides in , beside the order rows rather than derived
 * from them, so asking for one row returns the same shops as asking for a
 * hundred — and the ERP prices this by page size: measured on a live account,
 * limit=100 took 42s, limit=12 took 25s, limit=1 took 12s. The hundred-row
 * page was timing out every time, which is why a client with a perfectly
 * healthy session was told to type a shop code that exists nowhere they can
 * read it.
 */
function shopListUrl(): string {
  return ORDERS_URL + "?search_field=platformOrderId&shopIds=&page=1&limit=1";
}

function ordersUrl(shopId: string, page: number): string {
  // `shopIds` is the filter name the commission endpoint on this same ERP
  // takes. Correctness does not rest on it: every row is checked against the
  // shop id after parsing, so the parameter being ignored costs pages, not
  // accuracy.
  return (
    `${ORDERS_URL}?search_field=platformOrderId` +
    `&shopIds=${encodeURIComponent(shopId)}&page=${page}&limit=${PAGE_SIZE}`
  );
}

/**
 * Every order for one shop back to `since`, newest first.
 *
 * Stops at the first page whose oldest order predates the window rather than
 * reading to the end of a 221-page list.
 */
async function collectOrders(
  token: string,
  shopId: string,
  since: Date,
): Promise<{ orders: HstOrderCost[]; shops: HstShop[]; pages: number; unquotedLines: number }> {
  const orders: HstOrderCost[] = [];
  let shops: HstShop[] = [];
  let pages = 0;
  let unquotedLines = 0;
  // The window is a question about days: an order's day is the store's own,
  // as the ERP states its payment time in it, and needs no zone to read.
  const sinceDay = since.toISOString().slice(0, 10);

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await hstGet(ordersUrl(shopId, page), token);
    const parsed = parseHstOrderPage(payload, { shopId });
    pages += 1;
    if (parsed.shops.length > 0) shops = parsed.shops;
    unquotedLines += parsed.unquotedLines;

    for (const order of parsed.orders) {
      if (order.orderDay >= sinceDay) orders.push(order);
    }

    // A page with nothing readable on it is the end of anything useful; one
    // that reached past the window means the next page is older still.
    if (!parsed.oldestOrderDay || parsed.oldestOrderDay < sinceDay) break;
    if (page >= parsed.lastPage) break;
  }

  // Over everything collected, never per page: a family straddling a page
  // boundary would otherwise be judged on half its rows.
  decideFamilies(orders);

  return { orders, shops, pages, unquotedLines };
}

/**
 * Pull supplier costs for every store whose owner has connected HST.
 *
 * Never throws: the caller is an hourly cron whose other work must not be lost
 * because one client's ERP session expired. Failures travel in the result AND
 * are written against that client, so the next thing they see on their own
 * cost page says why — a sync that reports "ok" over nothing is the failure
 * mode this whole integration was already bitten by.
 */
export async function syncHstCosts(opts?: {
  client?: Supabase;
  /** Narrow to specific stores — the per-store "Sync now" button. */
  adAccountIds?: string[];
  sinceDays?: number;
  now?: Date;
}): Promise<HstCostSyncResult> {
  const result = emptyResult();
  const service = opts?.client ?? (await createClient());
  const now = opts?.now ?? new Date();
  const sinceDays = Math.max(1, Math.floor(opts?.sinceDays ?? DEFAULT_SINCE_DAYS));
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  const wanted = opts?.adAccountIds;
  const query = service
    .from("ad_accounts")
    .select("id, client_id, hst_shop_id")
    .not("hst_shop_id", "is", null);
  const { data: accounts, error: accountsError } = await (wanted ? query.in("id", wanted) : query);
  if (accountsError) {
    return { ...result, ok: false, error: accountsError.message };
  }

  const mapped = (
    (accounts ?? []) as Array<{ id: string; client_id: string; hst_shop_id: string | null }>
  ).filter((row): row is { id: string; client_id: string; hst_shop_id: string } =>
    Boolean(row.hst_shop_id),
  );
  result.accounts = mapped.length;
  if (mapped.length === 0) return result;

  // One session per client, not per store: a client with three stores signs in
  // once, and a client whose session is dead does not have it re-attempted for
  // every store they own.
  const tokens = new Map<string, string>();
  const renewed = new Set<string>();

  for (const account of mapped) {
    const store = {
      adAccountId: account.id,
      shopId: account.hst_shop_id,
      written: 0,
      unknownProducts: 0,
      charges: 0,
    } as HstCostSyncResult["stores"][number];

    try {
      let token = tokens.get(account.client_id);
      if (!token) {
        token = await clientHstToken(service, account.client_id);
        tokens.set(account.client_id, token);
      }

      // An order the supplier has not priced yet is re-read until it is, back
      // to the oldest one on file (capped). This read is an extra reach, not
      // the sync itself: if it fails, the normal window still runs, and the
      // hole it would have closed waits for the next hour rather than taking
      // the store's whole cost sync down with it.
      let accountSince = since;
      const floorDay = new Date(now.getTime() - HST_COST_REACH_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const { data: unpriced, error: unpricedError } = await service
        .from("hst_order_charges")
        .select("order_day")
        .eq("ad_account_id", account.id)
        .is("our_cost", null)
        .gte("order_day", floorDay)
        .order("order_day", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (unpricedError) {
        console.error(
          `HST cost sync: unpriced orders of ${account.id} could not be read; using the default window:`,
          unpricedError.message,
        );
      } else if (unpriced?.order_day) {
        const oldest = new Date(`${unpriced.order_day}T00:00:00.000Z`);
        if (oldest < accountSince) accountSince = oldest;
      }
      const sinceDay = accountSince.toISOString().slice(0, 10);
      if (result.since === null || sinceDay < result.since) result.since = sinceDay;

      let collected;
      try {
        collected = await collectOrders(token, account.hst_shop_id, accountSince);
      } catch (error) {
        // One retry per client on a refusal, and only one: a renewal that does
        // not help must not be attempted once per store they own.
        if (
          !(error instanceof HstError) ||
          !error.unauthorized ||
          renewed.has(account.client_id)
        ) {
          throw error;
        }
        renewed.add(account.client_id);
        token = await clientHstToken(service, account.client_id, { forceRenew: true });
        tokens.set(account.client_id, token);
        collected = await collectOrders(token, account.hst_shop_id, accountSince);
      }

      result.pages += collected.pages;
      result.unquotedLines += collected.unquotedLines;

      // Keep the shop-list cache warm off the same response the dropdown reads,
      // so a new shop appears after a sync and a slow supplier never empties it.
      if (collected.shops.length > 0) {
        await storeHstShops(service, account.client_id, collected.shops);
      }

      const outcome = await applyHstCosts({
        service,
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
      await noteClientHstError(service, account.client_id, null);
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.error = result.error ?? store.error;
      // The client is the only one who can fix their own login, and their cost
      // page is the only place they would look.
      await noteClientHstError(service, account.client_id, store.error).catch(() => {});
    }

    result.stores.push(store);
  }

  return result;
}

/**
 * The shops one client's HST login can see, for choosing which is their store.
 *
 * The list rides on the order list's own response, so asking costs a single
 * page and never needs a shop to be chosen first — which is what makes the
 * choice possible at all.
 */
export async function fetchHstShops(input: {
  service: Supabase;
  clientId: string;
}): Promise<HstShop[]> {
  const token = await clientHstToken(input.service, input.clientId);
  // Any shop id works here; the response carries the whole list regardless.
  // A generous timeout: this is the call that fills the cache, and some
  // accounts take ~14s to list — worth waiting for once so every later render
  // is instant.
  const payload = await hstGet(shopListUrl(), token, 45_000);
  const shops = parseHstOrderPage(payload, { shopId: "" }).shops;
  await storeHstShops(input.service, input.clientId, shops);
  return shops;
}

/**
 * One store's recent orders, as HST bills them, for the per-order view.
 *
 * Read live and returned as-is — nothing here is stored. The supplier ignores
 * the shop filter and answers with every shop the login can see, so a wide page
 * is fetched and narrowed to this store's rows afterwards; the display cap keeps
 * that from becoming a wall. One renewal on a refused token, then it gives up —
 * the same restraint the cost sync uses.
 */
export async function fetchHstStoreOrders(input: {
  service: Supabase;
  adAccountId: string;
  limit?: number;
}): Promise<HstOrderDisplay[]> {
  const { data } = await input.service
    .from("ad_accounts")
    .select("client_id, hst_shop_id")
    .eq("id", input.adAccountId)
    .maybeSingle();
  const account = data as { client_id: string; hst_shop_id: string | null } | null;
  const shopId = account?.hst_shop_id;
  if (!account || !shopId) return [];

  const cap = Math.min(120, Math.max(1, input.limit ?? 60));
  // Fetch more rows than we show: the login's other shops are interleaved, so a
  // page of `cap` could hold only a handful of this store's orders.
  const url =
    `${ORDERS_URL}?search_field=platformOrderId` +
    `&shopIds=${encodeURIComponent(shopId)}&page=1&limit=${Math.min(200, cap * 3)}`;

  const run = async (forceRenew: boolean): Promise<HstOrderDisplay[]> => {
    const token = await clientHstToken(
      input.service,
      account.client_id,
      forceRenew ? { forceRenew: true } : undefined,
    );
    const payload = await hstGet(url, token);
    return parseHstOrderDisplay(payload, { shopId, limit: cap });
  };

  try {
    return await run(false);
  } catch (error) {
    if (error instanceof HstError && error.unauthorized) return run(true);
    throw error;
  }
}
