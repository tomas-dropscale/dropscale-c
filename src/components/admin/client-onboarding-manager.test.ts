import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ExistingClientRosterDTO } from "@/lib/client-onboarding/legacy-roster";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import {
  availableOnboardingAssetKinds,
  buildClientCards,
  clientCardStatus,
  connectionTestTargets,
  onboardingSessionPurpose,
  occupiedOnboardingAssetKinds,
  openReconnectForAsset,
  openOnboardingSessions,
  runAssetConnectionTests,
  type AssetConnectionTestTarget,
} from "./client-onboarding-card-model";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const MANAGER_SOURCE = readFileSync(
  "src/components/admin/client-onboarding-manager.tsx",
  "utf8",
);

function roster(): ExistingClientRosterDTO {
  return {
    clientId: CLIENT_ID,
    fullName: "Northwind Demo",
    email: "owner@northwind.example",
    discordHandle: "northwind.demo",
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

function onboardingSession(
  overrides: Partial<ClientOnboardingSessionDTO> = {},
): ClientOnboardingSessionDTO {
  return {
    ...reconnectedSession(),
    mode: "add_assets",
    requestedAssets: ["google_ads"],
    status: "waiting",
    rawStatus: "pending",
    inviteExpiresAt: "2026-02-08T00:00:00.000Z",
    reconnectTarget: null,
    reconnectCompletedAt: null,
    submittedAt: null,
    reviewedAt: null,
    activatedAt: null,
    shopify: [],
    googleAds: [],
    mappings: [],
    needsReview: false,
    ...overrides,
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

describe("client card status", () => {
  it("waits for assets while any parallel link remains open", () => {
    const open = onboardingSession({
      id: "20000000-0000-4000-8000-000000000002",
      status: "expired",
      rawStatus: "pending",
    });
    const submitted = onboardingSession({
      id: "20000000-0000-4000-8000-000000000003",
      status: "submitted",
      rawStatus: "submitted",
    });
    const [card] = buildClientCards([submitted, open], [roster()]);

    expect(clientCardStatus(card)).toBe("waiting_for_assets");
  });

  it("treats a submitted client with a connected asset as approved", () => {
    const submitted = onboardingSession({
      status: "submitted",
      rawStatus: "submitted",
      googleAds: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          sessionId: SESSION_ID,
          customerId: "123-456-7890",
          accountName: "Main Ads",
          currency: "EUR",
          timeZone: "Europe/Lisbon",
          connectedAt: "2026-02-02T00:00:00.000Z",
          lastVerifiedAt: null,
          lastErrorCode: null,
        },
      ],
    });
    const [card] = buildClientCards([submitted], [roster()]);

    expect(clientCardStatus(card)).toBe("approved");
  });

  it("keeps a reviewed account-only setup empty", () => {
    const reviewed = onboardingSession({
      mode: "new_client",
      requestedAssets: [],
      status: "reviewed",
      rawStatus: "reviewed",
    });
    const [card] = buildClientCards([reviewed], []);

    expect(clientCardStatus(card)).toBe("no_assets");
  });

  it("keeps a pending legacy client without connections empty", () => {
    const [card] = buildClientCards(
      [],
      [{ ...roster(), approvalStatus: "pending", shopify: [] }],
    );

    expect(clientCardStatus(card)).toBe("no_assets");
  });

  it("marks an approved legacy client without assets as having no assets", () => {
    const [card] = buildClientCards([], [{ ...roster(), shopify: [] }]);

    expect(clientCardStatus(card)).toBe("no_assets");
  });

  it("marks an active account-only client as having no assets", () => {
    const active = onboardingSession({
      mode: "new_client",
      requestedAssets: [],
      status: "active",
      rawStatus: "active",
    });
    const [card] = buildClientCards([active], []);

    expect(clientCardStatus(card)).toBe("no_assets");
  });

  it("marks an approved client with an asset as approved", () => {
    const [card] = buildClientCards([], [roster()]);

    expect(clientCardStatus(card)).toBe("approved");
  });
});

describe("client approval controls", () => {
  it("has no manual approval state while preserving connection management", () => {
    expect(MANAGER_SOURCE).not.toContain("Waiting for approval");
    expect(MANAGER_SOURCE).not.toContain("Approve client");
    expect(MANAGER_SOURCE).not.toContain('action: "approve"');
    expect(MANAGER_SOURCE).not.toContain("reviewRosterClient");
    expect(MANAGER_SOURCE).toContain("Test all connections");
    expect(MANAGER_SOURCE).toContain("Add assets");
    expect(MANAGER_SOURCE).toContain("Reconnect");
    expect(MANAGER_SOURCE).toContain("Remove asset");
  });
});

describe("client onboarding card actions", () => {
  it("keeps reconnect slots exact and separate from Add assets", () => {
    const storeA = roster().shopify[0];
    const storeB = {
      ...storeA,
      id: "30000000-0000-4000-8000-000000000002",
      name: "Second store",
      domain: "second-store.myshopify.com",
    };
    const reconnectA = onboardingSession({
      id: "20000000-0000-4000-8000-000000000002",
      mode: "reconnect",
      requestedAssets: ["shopify"],
      status: "expired",
      rawStatus: "pending",
      reconnectTarget: reconnectedSession().reconnectTarget,
    });

    expect(occupiedOnboardingAssetKinds([reconnectA])).toEqual([]);
    expect(availableOnboardingAssetKinds([reconnectA])).toEqual([
      "shopify",
      "google_ads",
    ]);
    expect(openReconnectForAsset([reconnectA], storeA)).toBe(reconnectA);
    expect(openReconnectForAsset([reconnectA], storeB)).toBeNull();
    expect(
      openReconnectForAsset([reconnectA], {
        source: "onboarding",
        id: storeA.id,
      }),
    ).toBeNull();
  });

  it("lists two exact reconnect targets beside Google Ads", () => {
    const targetA = reconnectedSession().reconnectTarget!;
    const targetB = {
      ...targetA,
      id: "30000000-0000-4000-8000-000000000002",
      name: "Second store",
      domain: "second-store.myshopify.com",
    };
    const reconnectA = onboardingSession({
      id: "20000000-0000-4000-8000-000000000002",
      mode: "reconnect",
      requestedAssets: ["shopify"],
      reconnectTarget: targetA,
    });
    const reconnectB = onboardingSession({
      id: "20000000-0000-4000-8000-000000000003",
      mode: "reconnect",
      requestedAssets: ["shopify"],
      reconnectTarget: targetB,
    });
    const googleAds = onboardingSession({
      id: "20000000-0000-4000-8000-000000000004",
      rawStatus: "collecting",
      status: "collecting",
    });

    expect(openOnboardingSessions([reconnectA, reconnectB, googleAds])).toEqual([
      reconnectA,
      reconnectB,
      googleAds,
    ]);
    expect(occupiedOnboardingAssetKinds([reconnectA, reconnectB, googleAds])).toEqual([
      "google_ads",
    ]);
    expect(availableOnboardingAssetKinds([reconnectA, reconnectB, googleAds])).toEqual([
      "shopify",
    ]);
    expect(
      openReconnectForAsset([reconnectA, reconnectB, googleAds], targetB),
    ).toBe(reconnectB);
    expect(onboardingSessionPurpose(reconnectA)).toBe(
      "Reconnect Shopify · Old connection",
    );
    expect(onboardingSessionPurpose(googleAds)).toBe("Add Google Ads");
  });

  it("treats a combined open link as occupying both asset kinds", () => {
    const combined = onboardingSession({
      requestedAssets: ["shopify", "google_ads"],
    });

    expect(occupiedOnboardingAssetKinds([combined])).toEqual([
      "shopify",
      "google_ads",
    ]);
    expect(availableOnboardingAssetKinds([combined])).toEqual([]);
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
