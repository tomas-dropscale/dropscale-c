import { describe, expect, it } from "vitest";

import type { ExistingClientRosterDTO } from "@/lib/client-onboarding/legacy-roster";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import { buildClientCards } from "./client-onboarding-card-model";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";

function roster(): ExistingClientRosterDTO {
  return {
    clientId: CLIENT_ID,
    fullName: "Northwind Demo",
    email: "owner@northwind.example",
    approvalStatus: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    shopify: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        source: "legacy",
        name: "Old connection",
        domain: "northwind-demo.myshopify.com",
        currency: "EUR",
        grantedScopes: ["read_orders"],
        connectedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  };
}

function reconnectedSession(): ClientOnboardingSessionDTO {
  return {
    id: SESSION_ID,
    mode: "reconnect",
    requestedAssets: ["shopify"],
    status: "submitted",
    rawStatus: "submitted",
    inviteExpiresAt: null,
    targetClientId: CLIENT_ID,
    targetClientName: "Northwind Demo",
    claimedUserId: CLIENT_ID,
    firstName: "Northwind",
    lastName: "Demo",
    email: "owner@northwind.example",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
    submittedAt: "2026-02-02T00:00:00.000Z",
    reviewedAt: null,
    activatedAt: null,
    lastErrorCode: null,
    shopify: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        sessionId: SESSION_ID,
        name: "New connection",
        domain: "NORTHWIND-DEMO.myshopify.com",
        primaryDomain: "northwind.example",
        currency: "EUR",
        grantedScopes: ["read_orders", "read_reports"],
        connectedAt: "2026-02-02T00:00:00.000Z",
        lastVerifiedAt: null,
        lastErrorCode: null,
      },
    ],
    googleAds: [],
    mappings: [],
    needsReview: true,
  };
}

describe("client roster merge", () => {
  it("shows existing accounts even before they have an onboarding session", () => {
    const [card] = buildClientCards([], [roster()]);

    expect(card).toMatchObject({
      key: CLIENT_ID,
      clientId: CLIENT_ID,
      session: null,
      roster: { fullName: "Northwind Demo" },
    });
    expect(card.shopify).toHaveLength(1);
    expect(card.shopify[0].source).toBe("legacy");
    expect(card.googleAds).toEqual([]);
  });

  it("hides the old Shopify projection when the same domain is reconnected", () => {
    const [card] = buildClientCards([reconnectedSession()], [roster()]);

    expect(card.shopify).toHaveLength(1);
    expect(card.shopify[0]).toMatchObject({
      source: "onboarding",
      name: "New connection",
      domain: "NORTHWIND-DEMO.myshopify.com",
    });
  });
});
