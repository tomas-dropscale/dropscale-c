import "server-only";
import type { CampaignViewClient, CampaignActionHistory } from "./campaigns-view";
import { buildStoreCampaignDecisions, decisionRange, lastDecisionChange, type DecisionSnapshot } from "./campaign-decisions";
import { readCampaignDecisionSnapshot } from "./store-analytics";

/** Called after the authenticated Campaigns loader. Only cached evidence; never calls an ad mutation. */
export async function loadCampaignDecisions(clients: CampaignViewClient[], history: CampaignActionHistory[], asOf: string): Promise<CampaignViewClient[]> {
  const next = clients.map(c => ({ ...c, stores: c.stores.map(s => ({ ...s })) }));
  const jobs = next.flatMap(client => client.stores.map(store => async () => {
    if (!store.campaigns.length) return;
    const ranges = store.campaigns.map(c => decisionRange(lastDecisionChange(c, history, asOf), asOf));
    const fallback = decisionRange(null, asOf);
    const from = ranges.map(r => r.from).concat(fallback.from).sort()[0];
    let snapshot: DecisionSnapshot;
    try {
      snapshot = await readCampaignDecisionSnapshot({
        clientId: client.id,
        store: { accountId: store.id, currency: store.currency, activityAccountIds: store.activityAccountIds ?? [...new Set([store.id, ...store.campaigns.map(c => c.adAccountId)])], days: [] },
        range: { from, to: fallback.to },
      });
    } catch {
      snapshot = { rows: [], fees: null, refreshedAt: null, state: "unavailable" };
    }
    store.decisions = buildStoreCampaignDecisions(store.campaigns, history, snapshot, asOf);
  }));
  // Bound database fan-out on large agency portfolios.
  for (let index = 0; index < jobs.length; index += 4) await Promise.all(jobs.slice(index, index + 4).map(job => job()));
  return next;
}
