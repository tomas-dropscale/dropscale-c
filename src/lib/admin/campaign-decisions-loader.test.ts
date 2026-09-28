import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignViewClient } from "./campaigns-view";
const mocks=vi.hoisted(()=>({read:vi.fn(),build:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./store-analytics",()=>({readCampaignDecisionSnapshot:mocks.read}));
vi.mock("./campaign-decisions",async()=>({...await import("./campaign-decisions"),buildStoreCampaignDecisions:mocks.build}));
import { loadCampaignDecisions } from "./campaign-decisions-loader";

describe("decision loader source completeness",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue({rows:[],fees:null,state:"ready",refreshedAt:"2026-09-28T10:00:00Z"});mocks.build.mockReturnValue({campaigns:{},collections:{}});});
  const clients=(state="ready",stale=false)=>[{id:"client",stores:[{id:"store",currency:"EUR",activityAccountIds:["store","google-child"],campaignState:state,providerFreshness:{stale},campaigns:[{adAccountId:"google-child",providerCampaignId:"1",status:"active",startDate:"2026-09-28"}]}]}] as CampaignViewClient[];
  it("keeps the full canonical source scope and does not mutate the page input",async()=>{
    const input=clients();
    const result=await loadCampaignDecisions(input,[],"2026-09-28T11:00:00Z");
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({store:expect.objectContaining({activityAccountIds:["store","google-child"]})}));
    expect(mocks.build.mock.calls[0][2].state).toBe("ready");
    expect(input[0].stores[0].decisions).toBeUndefined();
    expect(result[0].stores[0].decisions).toBeDefined();
  });
  it.each([["partial",false],["ready",true]])("withholds recommendations when current campaign evidence is %s / stale=%s",async(state,stale)=>{
    await loadCampaignDecisions(clients(state,stale),[],"2026-09-28T11:00:00Z");
    expect(mocks.build.mock.calls[0][2].state).toBe("partial");
  });
});
