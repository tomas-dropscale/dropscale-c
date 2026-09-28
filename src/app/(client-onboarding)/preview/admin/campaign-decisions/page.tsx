import { notFound } from "next/navigation";
import { CampaignsView } from "@/components/admin/campaigns-view";
import { buildStoreCampaignDecisions } from "@/lib/admin/campaign-decisions";
import { projectFirstLandingRoas } from "@/lib/admin/campaign-first-landing";
import type { CampaignViewClient, CampaignActionHistory } from "@/lib/admin/campaigns-view";
import type { AdminAnalyticsCampaign } from "@/lib/admin/store-analytics";

export const metadata = { title: "Campanhas · pré-visualização local", robots: { index: false, follow: false } };

/** Synthetic data only; the exact production components, with ad controls disabled. */
export default function CampaignDecisionsPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  const asOf = "2026-09-28T12:00:00Z";
  const names = ["UK · Malhas · Prospecting", "UK · Malhas · Retargeting", "UK · Malhas · Teste", "PT · Casacos · Nova campanha", "PT · Vestidos · Sem custos"];
  const handles = ["malhas", "malhas", "malhas", "casacos", "vestidos"];
  const googleRevenue = [80, 20, 0, 60, 50];
  const campaigns = names.map((name,i) => ({ bindingId: "demo-binding", adAccountId: "demo-account", providerCampaignId: String(i+1), name, status: "active" as const, spend: 140, dailyBudget: "20", currency: "EUR", budgetCurrency: "EUR", type: "DEMAND_GEN", shoppingFeed: false, googleRoas: googleRevenue[i]/20, actionable: false }));
  const rows: AdminAnalyticsCampaign[] = campaigns.map((c,i) => ({ accountId: c.adAccountId, campaignId: c.providerCampaignId, collectionHandle: handles[i], timeline: Array.from({length:7},(_,d) => ({ bucket:`2026-09-${21+d}`, spend:20, googleRevenue:googleRevenue[i], conversions:googleRevenue[i]/40, firstLanding:{collection:{revenue:40,cogs:i===4?null:12,orders:1,units:1},campaign:null,unassignedGoogleRevenue:0} })) } as AdminAnalyticsCampaign));
  const landing = projectFirstLandingRoas(campaigns.map(c=>({ ...c, ad_account_id:c.adAccountId })), rows, asOf);
  const history: CampaignActionHistory[] = [0,1,2,3].map(i=>({id:`change-${i}`,adAccountId:"demo-account",providerCampaignId:String(i+1),campaignName:names[i],action:"budget_changed",outcome:"succeeded",previousDailyBudget:i===1?25:15,nextDailyBudget:20,currency:"EUR",occurredAt:`2026-09-${i===3?25:20}T10:00:00Z`,actorName:"Media buyer"}));
  const decisions = buildStoreCampaignDecisions(campaigns,history,{rows,fees:{paymentFeePct:2.9,paymentFeeFixed:0.3,shippingCostPerOrder:1,agencyFeeRate:10},state:"ready",refreshedAt:asOf},asOf);
  const clients: CampaignViewClient[] = [{id:"demo-client",name:"Loja de demonstração",email:"Dados de exemplo · sem ligação a contas reais",currency:"EUR",revenue:1400,adSpend:700,realRoas:2,stores:[{id:"demo-store",name:"Moda & Coleções",domain:"loja-exemplo.test",currency:"EUR",realRoas:2,rollupSpend:700,rollupComplete:true,campaignState:"ready",providerFreshness:{state:"ready",refreshedAt:asOf,lastAttemptAt:asOf,lastErrorCode:null,stale:false},decisions,campaigns:campaigns.map(c=>({...c,landingRoas:landing.get(`${c.adAccountId}:${c.providerCampaignId}`)}))}]}];
  return <main className="mx-auto min-h-screen max-w-[1680px] px-4 py-8 sm:px-8"><header className="mb-6"><p className="label-caps text-[var(--accent-gold-strong)]">DROPSCALE · PRÉ-VISUALIZAÇÃO LOCAL</p><h1 className="mt-2 text-3xl font-semibold text-[var(--text-primary)]">Campanhas</h1><p className="mt-2 text-sm text-[var(--text-muted)]">Explora os filtros e abre «Ver motivo». Estes dados são fictícios; os controlos de orçamento e pausa estão desativados.</p></header><CampaignsView clients={clients} history={history} historyTruncated={false} asOf={asOf} range={{key:"custom",from:"2026-09-21",to:"2026-09-27"}} /></main>;
}
