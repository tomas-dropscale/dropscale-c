/**
 * The daily report, for one calendar day, across every client.
 *
 * Built for an outside consumer (the Discord bot), which changes two things
 * about how it is written:
 *
 *   • It reads with the SERVICE ROLE. There is no session behind an API key, so
 *     RLS cannot be what scopes it — the key is the boundary, and this module
 *     is the only place that decides what a key holder may see.
 *   • It reports its own freshness. daily_metrics is a rollup refreshed when
 *     somebody opens a page, so a number can be hours old. `atualizado_em` says
 *     when, per store, rather than letting a stale figure pass as live.
 *
 * Store numbers come from the rollup (fast, stored). Campaign numbers come from
 * Google Ads LIVE, per account, because campaigns are never persisted here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptToken } from "@/lib/google-ads/crypto";
import { googleRoas } from "@/lib/admin/google-attribution";
import { currencyScope, displayCurrency } from "@/lib/portal/currency";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaignsDetailed } from "@/lib/google-ads/portal";
import { sumMetrics, type DailyMetricRow } from "@/lib/metrics/queries";
import { refreshAccountsNow } from "@/lib/metrics/recompute";
import { daysRunning } from "@/lib/portal/range";
import type { AdAccount, Database } from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

/** Campaign statuses, in the consumer's vocabulary. */
const ESTADO: Record<string, string> = {
  active: "ativa",
  paused: "pausada",
  ended: "terminada",
};

export type ReportCampaign = {
  id: string;
  nome: string;
  plataforma: "google";
  estado: string;
  inicio: string | null;
  dias_a_rodar: number | null;
  gasto: number;
  conversoes: number;
};

/**
 * Everything the client's own Dashboard shows, in the same arithmetic.
 *
 * Mirrored field by field on purpose: the report is read next to that screen,
 * and two numbers for the same thing is the fastest way to lose the client's
 * trust in both. Anything here can be checked against /dashboard for the same
 * day and must match exactly.
 */
export type ReportMetrics = {
  /** Gross Shopify revenue, before refunds. */
  receita_bruta: number;
  devolucoes: number;
  /** Gross minus refunds — the "REVENUE" card. */
  receita: number;
  encomendas: number;
  gasto: number;
  impressoes: number;
  cliques: number;
  // Cost breakdown, exactly as the panel lists it.
  custo_produtos: number;
  taxas_pagamento: number;
  envio: number;
  /** The agency's management fee on ad spend — the panel's "Dropscale fee". */
  taxa_dropscale: number;
  /** Revenue share billed on advertised collections. Not in the panel's box. */
  revenue_share: number;
  /** COGS + payment fees + shipping + ad spend. Our fee is NOT among them. */
  custos_totais: number;
  /** Trading profit BEFORE our management fee — see the note in metricsBlock. */
  lucro_liquido: number;
  /** lucro_liquido ÷ receita, 0–1. */
  margem: number;
  /** Receita ÷ gasto. The panel's ROAS and MER are both this number. */
  roas: number;
  mer: number;
  aov: number;
  /** Ad spend per store order — the panel's "Cost / conversion". */
  custo_por_encomenda: number;
  /** Store orders per ad click — the panel's "Conversion rate", 0–1. */
  taxa_conversao: number;
  /** Orders minus those Instagram/Facebook referred. Null = not computed yet. */
  conversoes: number | null;

  /**
   * Revenue with Instagram and Facebook referrals taken out — what the panel's
   * share card shows, so the two can be quoted side by side without one of them
   * looking wrong.
   *
   * The name says "google" because that is what the panel calls it and what
   * consumers already ask for, but read it as NOT-META rather than as
   * Google-attributed: direct, organic, email and every other non-Meta channel
   * are in here too. Google's own attributed figures are a different thing and
   * are usually near zero, because conversion tracking is rarely wired up.
   *
   * Null when no attribution has been computed for the day yet — never 0, which
   * would read as "sold nothing" instead of "not known yet".
   */
  receita_google: number | null;
  /** Orders behind that revenue. Same value as `conversoes`, named for callers
   *  that pair it with receita_google. */
  encomendas_google: number | null;
  /** receita_google ÷ gasto. Null follows receita_google; 0 when nothing spent. */
  roas_google: number | null;
};

export type ReportStore = ReportMetrics & {
  id: string;
  nome: string;
  dominio: string | null;
  /** When this store's rollup was last computed. Null = never. */
  atualizado_em: string | null;
  /** Empty when Google could not be queried — see `aviso`. */
  campanhas: ReportCampaign[];
  /** Set only when something could not be fetched, so zero is never a guess. */
  aviso?: string;
};

export type ReportClient = {
  id: string;
  nome: string;
  email: string;
  /** Management fee + revenue share. What the agency bills for the day. */
  comissao_agencia: number;
  /** The client's own Dashboard, all stores combined. */
  totais: ReportMetrics;
  lojas: ReportStore[];
};

export type DailyReport = {
  data: string;
  moeda: string;
  /**
   * The report spans more than one currency. Amounts are NOT converted, so
   * anything summed across clients or stores in this state is a sum of unlike
   * quantities. Per-store figures remain correct in their own currency.
   */
  moedas_mistas: boolean;
  /** Every currency present, sorted. Empty when nothing is set. */
  moedas: string[];
  fuso_horario: string;
  clientes: ReportClient[];
};

/**
 * One day, every client that can be reported on.
 *
 * `clientId` narrows to a single client (the `?cliente=` parameter). Clients
 * with no activity come back with zeroes rather than being dropped: the
 * consumer needs "spent nothing" and "no data" to look different.
 */
export async function buildDailyReport(
  supabase: Supabase,
  day: string,
  options: { clientId?: string; includeCampaigns?: boolean; refresh?: boolean } = {},
): Promise<DailyReport> {
  const includeCampaigns = options.includeCampaigns !== false;

  let clientQuery = supabase
    .from("portal_clients")
    .select("id, full_name, email")
    .eq("approval_status", "approved")
    .order("created_at", { ascending: true });
  if (options.clientId) clientQuery = clientQuery.eq("id", options.clientId);

  const { data: clients } = await clientQuery;
  if (!clients || clients.length === 0) {
    return {
      data: day,
      moeda: "EUR",
      moedas_mistas: false,
      moedas: [],
      fuso_horario: "loja",
      clientes: [],
    };
  }

  const clientIds = clients.map((client) => client.id);

  // Staff-owned stores are internal test accounts the agency never bills, and
  // the campaigns view already excludes them. A report that included them would
  // invent a client nobody recognises.
  const { data: staff } = await supabase.from("profiles").select("id").eq("role", "admin");
  const staffIds = new Set((staff ?? []).map((row) => row.id));

  const { data: accountRows } = await supabase
    .from("ad_accounts")
    .select("*")
    .in("client_id", clientIds)
    .order("created_at", { ascending: true });

  const accounts = ((accountRows ?? []) as AdAccount[]).filter(
    (account) => !staffIds.has(account.client_id),
  );

  // Live mode: re-pull the day from Google and Shopify BEFORE reading it, so
  // the answer is computed now rather than whenever a page last happened to be
  // opened. Writes the rollup as it goes, which means the cheap reads for the
  // rest of the day inherit the corrected numbers instead of drifting again.
  //
  // One request per account to each upstream, so this is for the once-a-night
  // call, never for polling.
  if (options.refresh && accounts.length > 0) {
    await refreshAccountsNow(
      accounts.map((account) => account.id),
      { client: supabase, from: day, to: day },
    );
  }

  const { data: metricRows } = await supabase
    .from("daily_metrics")
    .select("*")
    .in(
      "ad_account_id",
      accounts.map((account) => account.id),
    )
    .eq("day", day);

  const metricsByAccount = new Map<string, DailyMetricRow>();
  for (const row of (metricRows ?? []) as DailyMetricRow[]) {
    metricsByAccount.set(row.ad_account_id, row);
  }

  // Campaigns are one Google round trip per connected account. Done in parallel
  // and never allowed to fail the report: a store whose Google call breaks says
  // so in `aviso` and still reports its stored numbers.
  const campaignsByAccount = new Map<string, ReportCampaign[]>();
  const campaignErrors = new Map<string, string>();

  if (includeCampaigns && hasGoogleAdsEnv()) {
    await Promise.all(
      accounts
        .filter((account) => account.google_ads_connected && account.google_ads_customer_id)
        .map(async (account) => {
          try {
            if (!account.google_ads_refresh_token) {
              campaignErrors.set(account.id, "Google Ads sem token guardado.");
              return;
            }
            const token = await decryptToken(account.google_ads_refresh_token);
            const live = await fetchLiveCampaignsDetailed(
              account.google_ads_customer_id!,
              token,
              account.id,
              { key: "custom", from: day, to: day },
            );

            campaignsByAccount.set(
              account.id,
              live.map((campaign) => ({
                id: campaign.id,
                nome: campaign.name,
                // The only ad platform this product integrates. Stated rather
                // than implied, so the consumer never has to guess.
                plataforma: "google" as const,
                estado: ESTADO[campaign.status] ?? campaign.status,
                inicio: campaign.startDate,
                dias_a_rodar: daysRunning(campaign.startDate, day),
                gasto: round(campaign.spend),
                conversoes: round(campaign.conversions),
              })),
            );
          } catch (error) {
            campaignErrors.set(
              account.id,
              error instanceof Error ? error.message : "Falha ao consultar o Google Ads.",
            );
          }
        }),
    );
  }

  const byClient = new Map<string, AdAccount[]>();
  for (const account of accounts) {
    const bucket = byClient.get(account.client_id) ?? [];
    bucket.push(account);
    byClient.set(account.client_id, bucket);
  }

  const reported: ReportClient[] = clients
    .filter((client) => !staffIds.has(client.id))
    .map((client) => {
      const owned = byClient.get(client.id) ?? [];

      // The fee is summed per ACCOUNT, never from the combined spend: stores
      // bill at their own commission_rate, so one blended rate would be wrong
      // for every client with more than one. Same reason the panel does it.
      let clientFee = 0;
      let clientRevShare = 0;

      const lojas: ReportStore[] = owned.map((account) => {
        const row = metricsByAccount.get(account.id);
        const totals = sumMetrics(row ? [row] : []);
        const fee = (totals.adSpend * Number(account.commission_rate)) / 100;
        const revShare = row ? Number(row.revenue_share_amount ?? 0) : 0;

        clientFee += fee;
        clientRevShare += revShare;

        const failure = campaignErrors.get(account.id);
        return {
          id: account.id,
          nome: account.store_name,
          dominio: account.shopify_url,
          ...metricsBlock(totals, fee, revShare),
          atualizado_em: row?.computed_at ?? null,
          campanhas: campaignsByAccount.get(account.id) ?? [],
          ...(failure ? { aviso: failure } : {}),
        };
      });

      // All of this client's stores together — the view their Dashboard opens
      // on. Re-derived from the rows rather than summed from the per-store
      // blocks, so ratios (margin, ROAS, AOV) are computed once from the totals
      // instead of being averages of averages.
      const clientRows = owned
        .map((account) => metricsByAccount.get(account.id))
        .filter((row): row is DailyMetricRow => Boolean(row));

      return {
        id: client.id,
        nome: client.full_name,
        email: client.email,
        comissao_agencia: round(clientFee + clientRevShare),
        totais: metricsBlock(sumMetrics(clientRows), clientFee, clientRevShare),
        lojas,
      };
    });

  // Across EVERY client in the report, so mixed currencies are likelier here
  // than anywhere in the portal. The consumer is told rather than left to
  // assume one symbol covers the lot.
  const currencies = currencyScope(accounts);

  return {
    data: day,
    moeda: displayCurrency(currencies),
    /** True when the report spans more than one currency; amounts are NOT
     *  converted, so cross-client totals should not be added up. */
    moedas_mistas: currencies.mixed,
    moedas: currencies.currencies,
    // Not Europe/Lisbon, and saying so is the point: the day boundary is
    // whatever timezone each Google Ads account and Shopify store reports in.
    fuso_horario: "conta de anúncios / loja",
    clientes: reported,
  };
}

/** Two decimals, so the consumer never receives 13.350000000000001. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ratios keep four decimals — 3.36% would round to 0.03 at two. */
function ratio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The client Dashboard's figures, from one set of totals.
 *
 * The three the panel derives rather than stores are reproduced here with its
 * exact arithmetic (page.tsx): the fee is NOT part of `totals.profit`, so net
 * profit subtracts it separately and total costs add it back — the fee is what
 * the agency charges, not a cost the store incurred, and the two are only equal
 * by coincidence.
 */
function metricsBlock(
  totals: ReturnType<typeof sumMetrics>,
  fee: number,
  revShare: number,
): ReportMetrics {
  const attributed = totals.attributedRevenue;

  /**
   * The client's trading result, WITHOUT our management fee.
   *
   * This used to be `totals.profit - fee`. The panel stopped deducting the fee
   * — a shop that traded to €50 made €50, whatever it owes us afterwards — and
   * an API that kept deducting it would report €40 for the same day. Since the
   * entire reason these fields exist is that the two must agree, the fee comes
   * out here too. It is still reported separately as `taxa_dropscale`, so a
   * consumer that wants the after-fee figure can subtract it themselves.
   */
  const netProfit = totals.profit;
  const totalCosts =
    totals.adSpend + totals.productCost + totals.paymentFees + totals.shippingCost;

  return {
    receita_bruta: round(totals.revenue),
    devolucoes: round(totals.refunds),
    receita: round(totals.netRevenue),
    encomendas: totals.orders,
    gasto: round(totals.adSpend),
    impressoes: totals.impressions,
    cliques: totals.clicks,
    custo_produtos: round(totals.productCost),
    taxas_pagamento: round(totals.paymentFees),
    envio: round(totals.shippingCost),
    taxa_dropscale: round(fee),
    revenue_share: round(revShare),
    custos_totais: round(totalCosts),
    lucro_liquido: round(netProfit),
    margem: totals.netRevenue > 0 ? ratio(netProfit / totals.netRevenue) : 0,
    roas: round(totals.mer),
    mer: round(totals.mer),
    aov: round(totals.aov),
    custo_por_encomenda: round(totals.costPerOrder),
    taxa_conversao: ratio(totals.orderConversionRate),
    conversoes: totals.attributedOrders,
    receita_google: attributed === null ? null : round(attributed),
    encomendas_google: totals.attributedOrders,
    // Same helper the panel divides with, so the two ROAS figures cannot drift
    // apart through one of them rounding or guarding differently.
    roas_google: attributed === null ? null : round(googleRoas(attributed, totals.adSpend)),
  };
}
