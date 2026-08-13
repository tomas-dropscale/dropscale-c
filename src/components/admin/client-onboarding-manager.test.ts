import { describe, expect, it } from "vitest";

import type { ExistingClientRosterDTO } from "@/lib/client-onboarding/legacy-roster";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import {
  buildClientCards,
  connectionTestTargets,
  runAssetConnectionTests,
  type AssetConnectionTestTarget,
} from "./client-onboarding-card-model";

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
    reconnectTarget: {
      source: "legacy",
      id: "30000000-0000-4000-8000-000000000001",
      name: "Old connection",
      domain: "northwind-demo.myshopify.com",
      currency: "EUR",
    },
    reconnectCompletedAt: null,
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

describe("client connection tests", () => {
  it("keeps every asset result when tests finish out of order or fail", async () => {
    const secondStore = {
      ...roster().shopify[0],
      id: "30000000-0000-4000-8000-000000000002",
      name: "Second store",
      domain: "second-store.myshopify.com",
    };
    const card = buildClientCards([], [{ ...roster(), shopify: [...roster().shopify, secondStore] }])[0];
    card.googleAds.push({
      id: "50000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      customerId: "123-456-7890",
      accountName: "Main Ads",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      connectedAt: "2026-02-02T00:00:00.000Z",
      lastVerifiedAt: null,
      lastErrorCode: null,
    });
    const targets = connectionTestTargets(card);
    const releases = new Map<string, (result: { status: "connected" | "failed"; message?: string }) => void>();
    const started: string[] = [];
    const settled: string[] = [];

    const pending = runAssetConnectionTests(
      targets,
      (target) =>
        new Promise((resolve) => {
          started.push(target.key);
          releases.set(target.key, resolve);
        }),
      (result) => settled.push(result.key),
    );

    expect(started).toEqual(targets.map((target) => target.key));
    releases.get(targets[2].key)?.({ status: "failed", message: "Ads unavailable." });
    releases.get(targets[1].key)?.({ status: "connected" });
    releases.get(targets[0].key)?.({ status: "failed", message: "Orders unavailable." });

    const results = await pending;

    expect(settled).toEqual([targets[2].key, targets[1].key, targets[0].key]);
    expect(results).toEqual([
      { key: targets[0].key, status: "failed", message: "Orders unavailable." },
      { key: targets[1].key, status: "connected" },
      { key: targets[2].key, status: "failed", message: "Ads unavailable." },
    ]);
  });

  it("normalises a thrown request failure without rejecting the other assets", async () => {
    const targets: AssetConnectionTestTarget[] = [
      {
        key: "shopify:legacy:first",
        kind: "shopify",
        source: "legacy",
        id: "first",
        name: "First store",
        endpoint: "/first",
      },
      {
        key: "shopify:legacy:second",
        kind: "shopify",
        source: "legacy",
        id: "second",
        name: "Second store",
        endpoint: "/second",
      },
    ];

    const results = await runAssetConnectionTests(targets, async (target) => {
      if (target.id === "first") throw new Error("Shopify timed out.");
      return { status: "connected" as const };
    });

    expect(results).toEqual([
      { key: targets[0].key, status: "failed", message: "Shopify timed out." },
      { key: targets[1].key, status: "connected" },
    ]);
  });
});
