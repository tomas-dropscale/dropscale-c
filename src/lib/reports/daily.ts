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
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaignsDetailed } from "@/lib/google-ads/portal";
import { sumMetrics, type DailyMetricRow } from "@/lib/metrics/queries";
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

export type ReportStore = {
  id: string;
  nome: string;
  dominio: string | null;
  gasto: number;
  receita: number;
  encomendas: number;
  roas: number;
  /** When this store's rollup was last computed. Null = never. */
  atualizado_em: string | null;
  /** Absent (not empty) when Google could not be queried — see `aviso`. */
  campanhas: ReportCampaign[];
  /** Set only when something could not be fetched, so zero is never a guess. */
  aviso?: string;
};

export type ReportClient = {
  id: string;
  nome: string;
  email: string;
  comissao_agencia: number;
  lojas: ReportStore[];
};

export type DailyReport = {
  data: string;
  moeda: string;
  fuso_horario: string;
  clientes: ReportClient[];
};

/** Whole days between an ISO day and the report day, inclusive of the start. */
function daysRunning(start: string | null, day: string): number | null {
  if (!start) return null;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

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
  options: { clientId?: string; includeCampaigns?: boolean } = {},
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
    return { data: day, moeda: "EUR", fuso_horario: "loja", clientes: [] };
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
      let commission = 0;

      const lojas: ReportStore[] = owned.map((account) => {
        const row = metricsByAccount.get(account.id);
        const totals = sumMetrics(row ? [row] : []);

        // What the agency bills on this store for the day: the management fee
        // on ad spend, plus any revenue share already computed into the rollup.
        const fee = (totals.adSpend * Number(account.commission_rate)) / 100;
        const revShare = row ? Number(row.revenue_share_amount ?? 0) : 0;
        commission += fee + revShare;

        const failure = campaignErrors.get(account.id);
        return {
          id: account.id,
          nome: account.store_name,
          dominio: account.shopify_url,
          gasto: round(totals.adSpend),
          receita: round(totals.netRevenue),
          encomendas: totals.orders,
          roas: round(totals.mer),
          atualizado_em: row?.computed_at ?? null,
          campanhas: campaignsByAccount.get(account.id) ?? [],
          ...(failure ? { aviso: failure } : {}),
        };
      });

      return {
        id: client.id,
        nome: client.full_name,
        email: client.email,
        comissao_agencia: round(commission),
        lojas,
      };
    });

  return {
    data: day,
    moeda: accounts[0]?.currency ?? "EUR",
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
