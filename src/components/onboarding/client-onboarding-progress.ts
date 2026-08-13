import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";

type ShopifyProgress = Pick<
  ClientOnboardingSessionDTO,
  "id" | "mode" | "reconnectCompletedAt"
> & {
  shopify: readonly Pick<
    ClientOnboardingSessionDTO["shopify"][number],
    "sessionId"
  >[];
};

export function hasCurrentShopify(session: ShopifyProgress) {
  return session.mode === "reconnect"
    ? Boolean(session.reconnectCompletedAt)
    : session.shopify.some((store) => store.sessionId === session.id);
}
