import type {
  ExistingClientRosterDTO,
  LegacyShopifyAssetDTO,
} from "@/lib/client-onboarding/legacy-roster";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";

export type OnboardingShopifyAsset = ClientOnboardingSessionDTO["shopify"][number] & {
  source: "onboarding";
};
export type CardShopifyAsset = OnboardingShopifyAsset | LegacyShopifyAssetDTO;

export type ClientCard = {
  key: string;
  clientId: string | null;
  roster: ExistingClientRosterDTO | null;
  session: ClientOnboardingSessionDTO | null;
  sessions: ClientOnboardingSessionDTO[];
  shopify: CardShopifyAsset[];
  googleAds: ClientOnboardingSessionDTO["googleAds"];
};

export type ClientCardStatus =
  | "waiting_for_assets"
  | "waiting_for_approval"
  | "no_assets"
  | "approved";

export type AssetConnectionTestTarget = {
  key: string;
  kind: "shopify" | "google_ads";
  source: "legacy" | "onboarding";
  id: string;
  name: string;
  endpoint: string;
};

export type AssetConnectionTestResult = {
  key: string;
  status: "connected" | "failed";
  message?: string;
};

const ONBOARDING_ASSET_KINDS = ["shopify", "google_ads"] as const;

export type OnboardingAssetKind = (typeof ONBOARDING_ASSET_KINDS)[number];

function isOpenSession(session: ClientOnboardingSessionDTO) {
  return session.rawStatus === "pending" || session.rawStatus === "collecting";
}

export function openOnboardingSessions(
  sessions: readonly ClientOnboardingSessionDTO[],
) {
  return sessions.filter(isOpenSession);
}

export function occupiedOnboardingAssetKinds(
  sessions: readonly ClientOnboardingSessionDTO[],
): OnboardingAssetKind[] {
  const open = openOnboardingSessions(sessions).filter(
    (session) => session.mode !== "reconnect",
  );
  return ONBOARDING_ASSET_KINDS.filter((kind) =>
    open.some((session) => session.requestedAssets.includes(kind)),
  );
}

export function availableOnboardingAssetKinds(
  sessions: readonly ClientOnboardingSessionDTO[],
): OnboardingAssetKind[] {
  const occupied = new Set(occupiedOnboardingAssetKinds(sessions));
  return ONBOARDING_ASSET_KINDS.filter((kind) => !occupied.has(kind));
}

export function openReconnectForAsset(
  sessions: readonly ClientOnboardingSessionDTO[],
  asset: Pick<CardShopifyAsset, "source" | "id">,
) {
  return (
    openOnboardingSessions(sessions).find(
      (session) =>
        session.mode === "reconnect" &&
        session.reconnectTarget?.source === asset.source &&
        session.reconnectTarget.id === asset.id,
    ) ?? null
  );
}

export function onboardingAssetLabel(assets: readonly OnboardingAssetKind[]) {
  const shopify = assets.includes("shopify");
  const google = assets.includes("google_ads");
  if (shopify && google) return "Shopify & Google Ads";
  if (shopify) return "Shopify";
  if (google) return "Google Ads";
  return "Account only";
}

export function onboardingSessionPurpose(session: ClientOnboardingSessionDTO) {
  if (session.mode === "reconnect") {
    return session.reconnectTarget
      ? `Reconnect Shopify · ${session.reconnectTarget.name}`
      : "Reconnect Shopify";
  }
  if (session.mode === "add_assets") {
    return `Add ${onboardingAssetLabel(session.requestedAssets)}`;
  }
  return session.requestedAssets.length
    ? `Client setup · ${onboardingAssetLabel(session.requestedAssets)}`
    : "Create client account";
}

export function actionableReviewSession(
  sessions: readonly ClientOnboardingSessionDTO[],
) {
  return (
    sessions.find((session) => session.status === "submitted") ??
    sessions.find(
      (session) =>
        session.status === "reviewed" && session.requestedAssets.length === 0,
    ) ??
    null
  );
}

export function clientCardStatus(card: ClientCard): ClientCardStatus {
  if (openOnboardingSessions(card.sessions).length > 0) {
    return "waiting_for_assets";
  }
  if (
    actionableReviewSession(card.sessions) ||
    card.roster?.approvalStatus === "pending"
  ) {
    return "waiting_for_approval";
  }
  if (card.shopify.length === 0 && card.googleAds.length === 0) {
    return "no_assets";
  }
  return "approved";
}

export function assetConnectionKey(
  kind: AssetConnectionTestTarget["kind"],
  source: AssetConnectionTestTarget["source"],
  id: string,
) {
  return `${kind}:${source}:${id}`;
}

export function connectionTestTargets(card: ClientCard): AssetConnectionTestTarget[] {
  return [
    ...card.shopify.map((store) => ({
      key: assetConnectionKey("shopify", store.source, store.id),
      kind: "shopify" as const,
      source: store.source,
      id: store.id,
      name: store.name,
      endpoint: `/api/admin/client-onboarding/${
        store.source === "legacy" ? "legacy-shopify" : "shopify"
      }/${store.id}`,
    })),
    ...card.googleAds.map((account) => ({
      key: assetConnectionKey("google_ads", "onboarding", account.id),
      kind: "google_ads" as const,
      source: "onboarding" as const,
      id: account.id,
      name: account.accountName,
      endpoint: `/api/admin/client-onboarding/google/${account.id}`,
    })),
  ];
}

export async function runAssetConnectionTests(
  targets: readonly AssetConnectionTestTarget[],
  test: (target: AssetConnectionTestTarget) => Promise<Omit<AssetConnectionTestResult, "key">>,
  onResult?: (result: AssetConnectionTestResult) => void,
) {
  return Promise.all(
    targets.map(async (target) => {
      let result: AssetConnectionTestResult;
      try {
        result = { key: target.key, ...(await test(target)) };
      } catch (error) {
        result = {
          key: target.key,
          status: "failed",
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : `${target.name} could not be verified.`,
        };
      }
      onResult?.(result);
      return result;
    }),
  );
}

function canonicalClientKey(session: ClientOnboardingSessionDTO) {
  return session.claimedUserId ?? session.targetClientId ?? session.id;
}

function sessionRank(session: ClientOnboardingSessionDTO) {
  return new Date(session.updatedAt).getTime();
}

function normalizedDomain(domain: string) {
  return domain.trim().toLowerCase();
}

export function cardUpdatedAt(card: ClientCard) {
  return card.session?.updatedAt ?? card.roster?.createdAt ?? "";
}

export function buildClientCards(
  sessions: ClientOnboardingSessionDTO[],
  roster: ExistingClientRosterDTO[],
): ClientCard[] {
  const groups = new Map<string, ClientOnboardingSessionDTO[]>();
  for (const session of sessions) {
    const key = canonicalClientKey(session);
    const entries = groups.get(key) ?? [];
    entries.push(session);
    groups.set(key, entries);
  }
  const rosterByClient = new Map(roster.map((client) => [client.clientId, client]));
  const cards: ClientCard[] = [...groups.entries()].map(([key, entries]) => {
    const sorted = [...entries].sort(
      (left, right) => sessionRank(right) - sessionRank(left),
    );
    const session = sorted[0];
    const clientId = session.claimedUserId ?? session.targetClientId;
    const identity = clientId ? rosterByClient.get(clientId) ?? null : null;
    if (clientId) rosterByClient.delete(clientId);
    const shopify = new Map<string, CardShopifyAsset>();
    const googleAds = new Map<
      string,
      ClientOnboardingSessionDTO["googleAds"][number]
    >();
    for (const entry of sorted) {
      for (const store of entry.shopify) {
        const domain = normalizedDomain(store.domain);
        if (!shopify.has(domain)) {
          shopify.set(domain, { ...store, source: "onboarding" });
        }
      }
      for (const account of entry.googleAds) {
        if (!googleAds.has(account.id)) googleAds.set(account.id, account);
      }
    }
    for (const store of identity?.shopify ?? []) {
      const domain = normalizedDomain(store.domain);
      if (!shopify.has(domain)) shopify.set(domain, store);
    }
    return {
      key,
      clientId,
      roster: identity,
      session,
      sessions: sorted,
      shopify: [...shopify.values()],
      googleAds: [...googleAds.values()],
    };
  });

  for (const client of rosterByClient.values()) {
    cards.push({
      key: client.clientId,
      clientId: client.clientId,
      roster: client,
      session: null,
      sessions: [],
      shopify: client.shopify,
      googleAds: [],
    });
  }

  return cards.sort(
    (left, right) =>
      new Date(cardUpdatedAt(right)).getTime() -
      new Date(cardUpdatedAt(left)).getTime(),
  );
}
