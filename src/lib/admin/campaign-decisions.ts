import type { CampaignActionHistory, CampaignViewCampaign } from "./campaigns-view";
import type { AdminAnalyticsCampaign, CampaignSheetFees } from "./store-analytics";
import { firstLandingCollectionSales, sumLandingSales } from "./campaign-first-landing";

export type DecisionLevel = "ready" | "scale" | "review" | "reduce" | "maintain" | "learning" | "no_sales" | "missing" | "inactive";
export type DecisionDay = { day: string; spend: number; revenue: number; roas: number | null };
export type CampaignDecision = {
  level: DecisionLevel; reason: string; basis: "google" | "collection";
  from: string; to: string; days: number; coverage: number; provisional: boolean;
  changedAt: string | null; startedOn: string | null; refreshedAt: string | null;
  spend: number | null; revenue: number | null; roas: number | null;
  breakEven: number | null; collectionRoas: number | null;
  cogs: number | null; paymentFees: number | null; shipping: number | null;
  agencyFee: number | null; profit: number | null; conversions: number | null;
  fees: CampaignSheetFees | null; daily: DecisionDay[];
};
export type DecisionSnapshot = {
  rows: AdminAnalyticsCampaign[]; fees: CampaignSheetFees | null;
  refreshedAt: string | null; state: "ready" | "partial" | "unavailable";
};
export type StoreCampaignDecisions = {
  campaigns: Record<string, CampaignDecision>; collections: Record<string, CampaignDecision>;
};
const DAY = 86_400_000;
const lisbon = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" });
export const decisionDay = (at: string) => lisbon.format(new Date(at));
export const shiftDecisionDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const decisionCampaignKey = (account: string, campaign: string) => `${account}:${campaign}`;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Verified Dropscale actions only. No inferred launch date or fabricated external history. */
export function lastDecisionChange(campaign: Pick<CampaignViewCampaign, "adAccountId" | "providerCampaignId">, history: CampaignActionHistory[], asOf: string): string | null {
  return history.filter(h => h.adAccountId === campaign.adAccountId && h.providerCampaignId === campaign.providerCampaignId && h.outcome === "succeeded"
    && ["budget_changed", "campaign_paused", "campaign_enabled", "campaign_launched"].includes(h.action)
    && Number.isFinite(Date.parse(h.occurredAt)) && Date.parse(h.occurredAt) <= Date.parse(asOf)
    && (h.action !== "budget_changed" || (finite(h.previousDailyBudget) && finite(h.nextDailyBudget) && h.previousDailyBudget !== h.nextDailyBudget)))
    .sort((a,b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0]?.occurredAt ?? null;
}

export function campaignStartedOn(campaign: Pick<CampaignViewCampaign, "startDate">, asOf: string): string | null {
  const day = campaign.startDate;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))
    && new Date(day).toISOString().slice(0,10) === day && day <= decisionDay(asOf) ? day : null;
}

export function decisionRange(changedAt: string | null, asOf: string, startedOn?: string | null) {
  const today = decisionDay(asOf);
  const from = changedAt ? shiftDecisionDay(decisionDay(changedAt), 1) : shiftDecisionDay(today, -7);
  return { from: startedOn ? [from, shiftDecisionDay(startedOn, 1)].sort().at(-1)! : from, to: shiftDecisionDay(today, -1) };
}

export function decisionLevel(roas: number, breakEven: number): DecisionLevel {
  if (roas < breakEven - 1e-9) return "reduce";
  if (Math.abs(roas - breakEven) <= 1e-9) return "maintain";
  return roas > 3 ? "ready" : roas > 2 ? "scale" : "review";
}

function evaluate(input: {
  basis: "google" | "collection"; targets: AdminAnalyticsCampaign[];
  collection: AdminAnalyticsCampaign[]; active: boolean; changedAt: string | null;
  startedOn: string | null;
  provisional: boolean; snapshot: DecisionSnapshot; asOf: string; collectionComplete: boolean;
}): CampaignDecision {
  const { from, to } = decisionRange(input.changedAt, input.asOf, input.startedOn);
  const days = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1);
  const s: CampaignDecision = {
    level: "missing", reason: "Sincronizar os dados deste período em Analytics.", basis: input.basis,
    from, to, days, coverage: 0, provisional: input.provisional, changedAt: input.changedAt, startedOn: input.startedOn,
    refreshedAt: input.snapshot.refreshedAt, spend: null, revenue: null, roas: null, breakEven: null,
    collectionRoas: null, cogs: null, paymentFees: null, shipping: null, agencyFee: null,
    profit: null, conversions: null, fees: input.snapshot.fees, daily: [],
  };
  const points = (row: AdminAnalyticsCampaign) => row.timeline.filter(p => p.bucket.slice(0,10) >= from && p.bucket.slice(0,10) <= to);
  // Decision snapshots cover complete days. Mixed daily/hourly rows or duplicates double count.
  const validPoints = (row: AdminAnalyticsCampaign) => {
    const daily = points(row);
    return new Set(daily.map(p => p.bucket)).size === daily.length && daily.every(p =>
      /^\d{4}-\d{2}-\d{2}$/.test(p.bucket) && finite(p.spend) && p.spend >= 0 && finite(p.googleRevenue) && p.googleRevenue >= 0);
  };
  const daySets = input.targets.map(row => new Set(points(row).map(p => p.bucket.slice(0,10))));
  const covered = daySets.length ? [...daySets[0]].filter(day => daySets.every(set => set.has(day))) : [];
  s.coverage = covered.length;
  const complete = days > 0 && covered.length === days && input.targets.length > 0 && input.targets.every(validPoints)
    && (input.basis === "google" || input.collectionComplete);
  const allCollectionDays = input.collectionComplete && input.collection.length > 0 && input.collection.every(row => new Set(points(row).map(p => p.bucket.slice(0,10))).size === days && validPoints(row));
  const collectionPoints = input.collection.flatMap(points);
  const measuredSales = allCollectionDays ? sumLandingSales(collectionPoints.map(firstLandingCollectionSales)) : null;
  const sales = measuredSales && finite(measuredSales.revenue) && finite(measuredSales.orders) && measuredSales.orders >= 0 ? measuredSales : null;
  const collectionSpend = allCollectionDays ? collectionPoints.reduce((sum,p) => sum + p.spend, 0) : null;
  s.collectionRoas = sales && collectionSpend && collectionSpend > 0 ? sales.revenue / collectionSpend : null;
  const fees = input.snapshot.fees;
  const validFees = fees && Object.values(fees).every(v => finite(v) && v >= 0);
  if (sales && finite(sales.cogs) && sales.cogs >= 0 && finite(sales.revenue) && sales.revenue > 0 && finite(sales.orders) && sales.orders >= 0 && validFees) {
    s.cogs = sales.cogs;
    s.paymentFees = sales.revenue * fees.paymentFeePct / 100 + sales.orders * fees.paymentFeeFixed;
    s.shipping = sales.orders * fees.shippingCostPerOrder;
    const contribution = sales.revenue - sales.cogs - s.paymentFees - s.shipping;
    if (contribution > 0) s.breakEven = sales.revenue * (1 + fees.agencyFeeRate / 100) / contribution;
  }
  if (complete) {
    const rows = input.targets.flatMap(points);
    s.spend = rows.reduce((sum,p) => sum + p.spend, 0);
    s.conversions = rows.every(p => finite(p.conversions)) ? rows.reduce((sum,p) => sum + p.conversions!, 0) : null;
    s.revenue = input.basis === "google" ? rows.reduce((sum,p) => sum + p.googleRevenue, 0) : sales?.revenue ?? null;
    s.roas = s.revenue !== null && s.spend > 0 ? s.revenue / s.spend : null;
    s.agencyFee = validFees ? s.spend * fees.agencyFeeRate / 100 : null;
    if (input.basis === "collection" && sales && validFees && finite(sales.cogs) && sales.cogs >= 0) {
      s.cogs = sales.cogs;
      s.paymentFees = sales.revenue * fees.paymentFeePct / 100 + sales.orders * fees.paymentFeeFixed;
      s.shipping = sales.orders * fees.shippingCostPerOrder;
      s.profit = sales.revenue - sales.cogs - s.paymentFees - s.shipping - s.spend - s.agencyFee!;
    }
    s.daily = covered.sort().flatMap(day => {
      const daily = rows.filter(p => p.bucket.slice(0,10) === day);
      const spend = daily.reduce((sum,p) => sum + p.spend, 0);
      const rev = input.basis === "google" ? daily.reduce((sum,p) => sum + p.googleRevenue, 0) : sumLandingSales(daily.map(firstLandingCollectionSales))?.revenue;
      return rev == null ? [] : [{ day, spend, revenue: rev, roas: spend > 0 ? rev / spend : null }];
    });
  }
  const finish = (level: DecisionLevel, reason: string) => ({ ...s, level, reason });
  if (!input.active) return finish("inactive", input.basis === "collection" ? "As campanhas atuais desta coleção estão pausadas ou terminadas. Sem recomendação de scale." : "Campanha pausada ou terminada. Sem recomendação de scale.");
  if (days === 0) return finish("learning", input.startedOn && !input.changedAt ? "Campanha nova: a aguardar o primeiro dia completo após o início." : "A aguardar o primeiro dia completo após a alteração.");
  if (input.basis === "collection" && !input.collectionComplete) return finish("missing", "O histórico ainda não inclui todas as campanhas atuais desta coleção, ou o link mudou. Sincronizar o período antes de avaliar.");
  if (!complete) return finish("missing", `Dados incompletos: ${s.coverage}/${days} dias. Abrir Analytics e sincronizar o período.`);
  if (input.snapshot.state !== "ready") return finish("missing", "A sincronização está incompleta. Confirmar os dados em Analytics.");
  if (!s.refreshedAt || !Number.isFinite(Date.parse(s.refreshedAt)) || decisionDay(s.refreshedAt) <= to || Date.parse(s.refreshedAt) > Date.parse(input.asOf) + 300_000 || Date.parse(input.asOf) - Date.parse(s.refreshedAt) > 36 * 3_600_000) return finish("missing", "Dados desatualizados ou recolhidos antes do fecho do período. Sincronizar em Analytics.");
  if (s.spend === 0) return finish("learning", "Sem gasto neste período. Aguardar entrega antes de avaliar.");
  if (s.revenue === null) return finish("missing", "Atribuição incompleta: faltam dados da primeira visita de vendas da coleção. Confirmar o link e sincronizar Shopify; ausência de atribuição não significa zero vendas.");
  if (s.revenue <= 0) return finish("no_sales", input.basis === "google"
    ? `Há gasto, mas o Google não atribui receita a esta campanha.${sales && sales.revenue > 0 ? " A coleção tem vendas; verificar a medição de conversões antes de decidir." : " Rever entrega, vendas e medição antes de decidir."}`
    : "Há gasto e nenhuma receita líquida atribuída à primeira visita à coleção. Rever a campanha e a medição.");
  if (days < 5) return finish("learning", `Observar: ${days}/5 dias completos após o início ou a última alteração. Evitar decidir com o dia de hoje.`);
  if (!input.collection.length) return finish("missing", "Falta associar a campanha a uma coleção para estimar o ROAS de equilíbrio.");
  if (!allCollectionDays || !sales) return finish("missing", "Faltam vendas ou dias da coleção para estimar o equilíbrio. Sincronizar em Analytics.");
  if (s.breakEven === null) return finish("missing", "Equilíbrio indisponível: confirmar custos, taxas e margem positiva dos produtos da coleção.");
  const level = decisionLevel(s.roas!, s.breakEven);
  const reasons: Partial<Record<DecisionLevel, string>> = {
    ready: "ROAS acima do equilíbrio e de 3x. Prioridade para analisar scale.",
    scale: "ROAS acima do equilíbrio e de 2x. Candidata a scale.",
    review: "Acima do equilíbrio, mas até 2x. Avaliar estabilidade antes de subir o orçamento.",
    reduce: "ROAS abaixo do equilíbrio. Avaliar descalar ou kill, após confirmar a medição.",
    maintain: "ROAS no equilíbrio estimado. Manter em observação.",
  };
  return finish(level, reasons[level]!);
}

/** Collection sales are summed once; Google values stay on their exact account + campaign. */
export function buildStoreCampaignDecisions(campaigns: CampaignViewCampaign[], history: CampaignActionHistory[], snapshot: DecisionSnapshot, asOf: string): StoreCampaignDecisions {
  const result: StoreCampaignDecisions = { campaigns: {}, collections: {} };
  const indexed = new Map(snapshot.rows.map(r => [decisionCampaignKey(r.accountId, r.campaignId), r]));
  const handleFor = (c: CampaignViewCampaign) => c.landingRoas?.handle ?? indexed.get(decisionCampaignKey(c.adAccountId, c.providerCampaignId))?.collectionHandle;
  const groups = new Map<string, { rows: AdminAnalyticsCampaign[]; members: CampaignViewCampaign[]; complete: boolean }>();
  for (const campaign of campaigns) {
    const handle = handleFor(campaign);
    if (!handle || groups.has(handle)) continue;
    const rows = snapshot.rows.filter(r => r.collectionHandle === handle);
    const members = campaigns.filter(c => handleFor(c) === handle);
    const complete = members.every(c => indexed.get(decisionCampaignKey(c.adAccountId, c.providerCampaignId))?.collectionHandle === handle)
      && rows.every(r => !campaigns.some(c => c.adAccountId === r.accountId && c.providerCampaignId === r.campaignId && handleFor(c) !== handle));
    groups.set(handle, { rows, members, complete });
  }
  for (const campaign of campaigns) {
    const key = decisionCampaignKey(campaign.adAccountId, campaign.providerCampaignId);
    const row = indexed.get(key);
    const group = groups.get(handleFor(campaign) ?? "");
    const collection = group?.rows ?? [];
    const changedAt = lastDecisionChange(campaign, history, asOf);
    result.campaigns[key] = evaluate({ basis: "google", targets: row ? [row] : [], collection, collectionComplete: group?.complete ?? false, active: campaign.status === "active", changedAt, startedOn: campaignStartedOn(campaign, asOf), provisional: !changedAt, snapshot, asOf });
  }
  for (const [handle, group] of groups) {
    const changes = group.members.map(c => lastDecisionChange(c, history, asOf));
    const latest = changes.filter((c): c is string => Boolean(c)).sort((a,b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const startedOn = group.members.map(c => campaignStartedOn(c, asOf)).filter((day): day is string => Boolean(day)).sort().at(-1) ?? null;
    result.collections[handle] = evaluate({ basis: "collection", targets: group.rows, collection: group.rows, collectionComplete: group.complete,
      active: group.members.some(c => c.status === "active"), changedAt: latest, startedOn, provisional: changes.some(c => !c), snapshot, asOf });
  }
  return result;
}
