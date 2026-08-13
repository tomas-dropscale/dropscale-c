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
