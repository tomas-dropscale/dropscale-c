import { describe, expect, it } from "vitest";
import { firstVisitGoogleCampaign, matchFirstVisitCampaign, projectFirstLandingRoas, sumFirstLanding } from "./campaign-first-landing";

describe("first visit campaign evidence", () => {
  it("requires paid Google evidence and retains the exact campaign identity", () => {
    expect(firstVisitGoogleCampaign("/collections/summer?utm_source=google&utm_medium=cpc&utm_campaign=123", null)).toMatchObject({ googleAds: true, campaign: "123" });
    expect(firstVisitGoogleCampaign("/collections/summer?gclid=click&gad_campaignid=123", null)).toMatchObject({ googleAds: true, campaign: "123" });
    expect(firstVisitGoogleCampaign("/collections/summer", { source: "google", medium: "organic", campaign: "123" }).googleAds).toBe(false);
    expect(firstVisitGoogleCampaign("/collections/summer", { source: "facebook", medium: "cpc", campaign: "123" }).googleAds).toBe(false);
    expect(firstVisitGoogleCampaign(null, null)).toMatchObject({ googleAds: false, campaign: null });
    expect(firstVisitGoogleCampaign("/collections/summer", { source: "Google", medium: null, campaign: null })).toMatchObject({ googleAds: false, unclassifiedGoogle: true });
    expect(firstVisitGoogleCampaign("/collections/summer", { source: "android-app://com.google.android.googlequicksearchbox/", medium: null, campaign: null }).unclassifiedGoogle).toBe(true);
    expect(firstVisitGoogleCampaign("/collections/summer?gclid=x&utm_campaign={campaignid}", null)).toMatchObject({ googleAds: true, campaign: null });
  });

  it("does not guess a campaign or split unidentified orders between campaigns", () => {
    const campaigns = [{ key: "a:123", id: "123", name: "Summer" }, { key: "b:456", id: "456", name: "Summer" }];
    expect(matchFirstVisitCampaign("123", campaigns)).toBe("a:123");
    expect(matchFirstVisitCampaign("Summer", campaigns)).toBeNull();
    expect(matchFirstVisitCampaign(null, campaigns)).toBeNull();
    expect(matchFirstVisitCampaign("123", [...campaigns, { key: "b:123", id: "123", name: "Other" }])).toBeNull();
  });
});

describe("collection and campaign ROAS", () => {
  const sales = (revenue: number) => ({ revenue, orders: 1, units: 1, cogs: 10 });
  const rows = [
    { accountId: "a", campaignId: "1", collectionHandle: "summer", timeline: [{ firstLanding: { collection: sales(75), campaign: sales(20), unassignedGoogleRevenue: 0 } }] },
    { accountId: "a", campaignId: "2", collectionHandle: "summer", timeline: [{ firstLanding: { collection: sales(25), campaign: sales(50), unassignedGoogleRevenue: 0 } }] },
  ];
  it("adds collection shares once but uses exact campaign sales, not spend shares", () => {
    const projected = projectFirstLandingRoas([{ ad_account_id: "a", providerCampaignId: "1", spend: 30 }, { ad_account_id: "a", providerCampaignId: "2", spend: 10 }], rows, "2026-09-25T12:00:00Z");
    expect(projected.get("a:1")).toMatchObject({ collectionRevenue: 100, collectionRoas: 2.5, roas: 20 / 30, unassignedGoogleRevenue: 0 });
    expect(projected.get("a:2")).toMatchObject({ collectionRevenue: 100, collectionRoas: 2.5, roas: 5 });
  });
  it("withholds partial or old attribution and never substitutes a zero", () => {
    expect(sumFirstLanding([rows[0].timeline[0].firstLanding, undefined]).collection).toBeNull();
    const result = projectFirstLandingRoas([{ ad_account_id: "a", providerCampaignId: "1", spend: 0 }], rows, null).get("a:1");
    expect(result?.roas).toBeNull();
    expect(result?.collectionRoas).toBeNull();
  });
  it("distinguishes unknown first visits from measured zero collection sales", () => {
    const current=[{ad_account_id:"a",providerCampaignId:"1",spend:30},{ad_account_id:"a",providerCampaignId:"2",spend:10}];
    const unknown=rows.map(r=>({...r,timeline:r.timeline.map(p=>({...p,collectionUnknownOrders:1}))}));
    expect(projectFirstLandingRoas(current,unknown,"now").get("a:1")).toMatchObject({collectionRevenue:null,collectionRoas:null});
    const zero=rows.map(r=>({...r,timeline:r.timeline.map(p=>({...p,firstLanding:{...p.firstLanding,collection:sales(0)}}))}));
    expect(projectFirstLandingRoas(current,zero,"now").get("a:1")).toMatchObject({collectionRevenue:0,collectionRoas:0});
    expect(projectFirstLandingRoas(current,[...rows,rows[0]],"now").size).toBe(0);
  });
  it("does not keep an inflated collection ratio when the current Google inventory adds a campaign", () => {
    const current=[{ad_account_id:"a",providerCampaignId:"1",spend:30,collectionHandle:"summer"},{ad_account_id:"a",providerCampaignId:"2",spend:10,collectionHandle:"summer"},{ad_account_id:"a",providerCampaignId:"3",spend:20,collectionHandle:"summer"}];
    const result=projectFirstLandingRoas(current,rows,"now");
    expect(result.get("a:1")).toMatchObject({handle:"summer",collectionRevenue:null,collectionRoas:null});
    expect(result.get("a:3")).toMatchObject({handle:"summer",collectionRevenue:null,collectionRoas:null});
    current[0].collectionHandle="winter";
    expect(projectFirstLandingRoas(current,rows,"now").get("a:1")).toMatchObject({handle:"winter",collectionRevenue:null,roas:null});
    expect(projectFirstLandingRoas([{...current[0],collectionHandle:null}],rows,"now").size).toBe(0);
  });
});
