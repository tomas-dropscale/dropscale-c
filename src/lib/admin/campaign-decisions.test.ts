import { describe, expect, it } from "vitest";
import { buildStoreCampaignDecisions, decisionLevel, decisionRange, lastDecisionChange, type DecisionSnapshot } from "./campaign-decisions";
import type { CampaignViewCampaign, CampaignActionHistory } from "./campaigns-view";
import type { AdminAnalyticsCampaign } from "./store-analytics";

const now = "2026-09-28T11:00:00Z";
const campaigns = ["1", "2", "3"].map(providerCampaignId => ({ adAccountId: "a", providerCampaignId, status: "active" } as CampaignViewCampaign));
function history(id = "1", occurredAt = "2026-09-20T11:00:00Z", extra = {}): CampaignActionHistory {
  return { id: "op", adAccountId: "a", providerCampaignId: id, campaignName: "Blusas", action: "budget_changed", outcome: "succeeded", previousDailyBudget: 10, nextDailyBudget: 12, currency: "EUR", occurredAt, actorName: "Buyer", ...extra };
}
function snapshot(): DecisionSnapshot {
  return { state: "ready", refreshedAt: "2026-09-28T10:00:00Z", fees: { paymentFeePct: 3, paymentFeeFixed: 0.3, shippingCostPerOrder: 1, agencyFeeRate: 10 }, rows: campaigns.map((c,index) => ({
    accountId: c.adAccountId, campaignId: c.providerCampaignId, collectionHandle: "blusas", timeline: Array.from({ length: 8 }, (_,i) => ({
      bucket: `2026-09-${21+i}`, spend: 10, googleRevenue: [40,25,5][index], conversions: 1,
      firstLanding: { collection: { revenue: 30, cogs: 6, orders: 1, units: 1 }, campaign: null, unassignedGoogleRevenue: 0 },
    })),
  } as AdminAnalyticsCampaign)) };
}
const get = (s = snapshot(), h: CampaignActionHistory[] = [], cs = campaigns) => buildStoreCampaignDecisions(cs,h,s,now);

describe("media buyer decisions", () => {
  it("keeps exact individual Google ROAS and a single all-channel collection total", () => {
    const result = get();
    expect(Object.values(result.campaigns).map(s=>s.roas)).toEqual([4,2.5,0.5]);
    expect(Object.values(result.campaigns).map(s=>s.level)).toEqual(["ready","scale","reduce"]);
    expect(result.collections.blusas).toMatchObject({ revenue: 630, spend: 210, roas: 3, days: 7, coverage: 7, provisional: true });
    expect(result.collections.blusas.profit).toBeCloseTo(226.8);
    expect(result.campaigns["a:1"].profit).toBeNull();
    expect(result.campaigns["a:1"].breakEven).toBeCloseTo(630*1.1/(630-126-25.2-21));
  });
  it("excludes today and the change day; status changes also reset the window", () => {
    const result = get(snapshot(),[history("1","2026-09-23T09:00:00Z",{action:"campaign_enabled"})]);
    expect(result.campaigns["a:1"]).toMatchObject({ from:"2026-09-24",to:"2026-09-27",days:4,revenue:160,spend:40,level:"learning" });
    expect(result.collections.blusas.days).toBe(4);
  });
  it("uses Lisbon midnight across UTC boundaries and DST", () => {
    expect(decisionRange("2026-09-22T23:15:00Z",now).from).toBe("2026-09-24");
    expect(decisionRange("2026-10-24T23:30:00Z","2026-10-27T11:00:00Z")).toEqual({from:"2026-10-26",to:"2026-10-26"});
  });
  it("requires five full days and evaluates the whole window after the change", () => {
    const s = get(snapshot(),[history("1","2026-09-22T09:00:00Z")]).campaigns["a:1"];
    expect(s).toMatchObject({ level:"ready",days:5,provisional:false,spend:50 });
    expect(get(snapshot(),[history()]).campaigns["a:1"].days).toBe(7);
  });
  it("does not collapse missing campaign days to zeros or issue a scale signal", () => {
    const s=snapshot(); s.rows[0].timeline.splice(2,1);
    expect(get(s).campaigns["a:1"]).toMatchObject({ level:"missing",coverage:6,spend:null,roas:null });
    expect(get(s).collections.blusas.level).toBe("missing");
  });
  it("reports zero Google revenue explicitly even with Shopify sales", () => {
    const s=snapshot(); s.rows[0].timeline.forEach(p=>{p.googleRevenue=0;});
    const result=get(s).campaigns["a:1"];
    expect(result).toMatchObject({ level:"no_sales",roas:0 });
    expect(result.reason).toContain("A coleção tem vendas");
  });
  it("does not label zero collection sales as maintain, and shows its loss", () => {
    const s=snapshot(); s.rows.forEach(r=>r.timeline.forEach(p=>{p.firstLanding!.collection={ revenue:0,orders:0,units:0,cogs:0 };}));
    expect(get(s).collections.blusas).toMatchObject({level:"no_sales",profit:-231,breakEven:null});
  });
  it("withholds signals for unknown costs, missing landing evidence and stale/partial data", () => {
    const cost=snapshot();cost.rows[0].timeline[0].firstLanding!.collection!.cogs=null;
    expect(get(cost).campaigns["a:1"]).toMatchObject({level:"missing",breakEven:null});
    const landing=snapshot();delete landing.rows[0].timeline[0].firstLanding;
    expect(get(landing).collections.blusas).toMatchObject({level:"missing",revenue:null});
    expect(get({...snapshot(),state:"partial"}).campaigns["a:1"].level).toBe("missing");
    expect(get({...snapshot(),refreshedAt:"2026-09-27T21:00:00Z"}).campaigns["a:1"].level).toBe("missing");
    expect(get({...snapshot(),fees:null}).campaigns["a:1"].level).toBe("missing");
  });
  it("never assigns another account's matching campaign id", () => {
    const s=snapshot();s.rows[0].accountId="other";
    expect(get(s).campaigns["a:1"]).toMatchObject({level:"missing",roas:null});
  });
  it("ignores failed, no-op, future and unrelated history", () => {
    expect(lastDecisionChange(campaigns[0],[history("1",now,{outcome:"failed"}),history("1",now,{previousDailyBudget:12}),history("1","2026-09-29T10:00:00Z"),history("1",now,{adAccountId:"other"})],now)).toBeNull();
  });
  it("does not recommend scaling a paused campaign or one without spend", () => {
    expect(get(snapshot(),[],[{...campaigns[0],status:"paused"}]).campaigns["a:1"].level).toBe("inactive");
    const s=snapshot();s.rows[0].timeline.forEach(p=>{p.spend=0;});
    expect(get(s).campaigns["a:1"]).toMatchObject({level:"learning",roas:null});
  });
  it("compares with breakeven before the 2x and 3x thresholds, without averaging daily ROAS", () => {
    expect(decisionLevel(3.2,4)).toBe("reduce");
    expect(decisionLevel(2,2)).toBe("maintain");
    expect(decisionLevel(2,1.8)).toBe("review");
    expect(decisionLevel(3,1.8)).toBe("scale");
    const s=snapshot();s.rows[0].timeline[0].spend=100;
    expect(get(s).campaigns["a:1"].roas).toBeCloseTo(280/160);
  });

  it("does not mark a collection inactive when a new active member is absent from its history", () => {
    const s=snapshot();
    const cs=campaigns.map(c=>({...c,status:"paused" as const}));
    const fresh={...campaigns[0],providerCampaignId:"new",landingRoas:{handle:"blusas"} as CampaignViewCampaign["landingRoas"]};
    const result=get(s,[],[...cs,fresh]);
    expect(result.collections.blusas).toMatchObject({level:"missing",spend:null,roas:null});
    expect(result.collections.blusas.reason).toContain("todas as campanhas atuais");
    expect(result.campaigns["a:new"].level).toBe("missing");
  });

  it("uses Google's actual launch date and never counts pre-launch zeros as learning days", () => {
    const cs=campaigns.map(c=>({...c,startDate:"2026-09-25"}));
    expect(get(snapshot(),[],cs).campaigns["a:1"]).toMatchObject({level:"learning",days:2,from:"2026-09-26",revenue:80});
    const fresh={...campaigns[0],providerCampaignId:"new",startDate:"2026-09-28",landingRoas:{handle:"blusas"} as CampaignViewCampaign["landingRoas"]};
    const result=get(snapshot(),[],[...campaigns,fresh]);
    expect(result.campaigns["a:new"]).toMatchObject({level:"learning",days:0,spend:null,roas:null});
    expect(result.collections.blusas).toMatchObject({level:"learning",days:0});
    expect(get(snapshot(),[],[{...campaigns[0],startDate:"bad-date"}]).campaigns["a:1"].days).toBe(7);
  });

  it("does not apply an old collection margin after a campaign changes its landing collection", () => {
    const moved={...campaigns[0],landingRoas:{handle:"casacos"} as CampaignViewCampaign["landingRoas"]};
    const result=get(snapshot(),[],[moved,...campaigns.slice(1)]);
    expect(result.campaigns["a:1"]).toMatchObject({level:"missing",roas:4,breakEven:null});
    expect(result.collections.casacos.level).toBe("missing");
    expect(result.collections.blusas.level).toBe("missing");
  });

  it("withholds collection results when relevant orders have unknown first visits, including older snapshots", () => {
    for (const legacy of [false,true]) {
      const s=snapshot();
      if (legacy) s.rows[0].timeline[0].collectionUnknownOrders=1;
      else s.rows[0].timeline[0].firstLanding!.collectionComplete=false;
      const result=get(s);
      expect(result.collections.blusas).toMatchObject({level:"missing",roas:null,revenue:null});
      expect(result.campaigns["a:1"]).toMatchObject({level:"missing",roas:4,breakEven:null});
    }
  });

  it("rejects duplicate daily rows, mixed granularities and invalid refresh dates", () => {
    const duplicate=snapshot(); duplicate.rows[0].timeline.push(duplicate.rows[0].timeline[0]);
    expect(get(duplicate).campaigns["a:1"]).toMatchObject({level:"missing",spend:null});
    const hourly=snapshot(); hourly.rows[0].timeline.push({...hourly.rows[0].timeline[0],bucket:"2026-09-21T01:00:00"});
    expect(get(hourly).campaigns["a:1"]).toMatchObject({level:"missing",spend:null});
    expect(get({...snapshot(),refreshedAt:"bad-date"}).campaigns["a:1"].level).toBe("missing");
    expect(get({...snapshot(),refreshedAt:"2026-09-29T11:00:00Z"}).campaigns["a:1"].level).toBe("missing");
  });
});
