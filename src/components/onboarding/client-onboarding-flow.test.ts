import { describe, expect, it } from "vitest";

import { hasCurrentShopify } from "./client-onboarding-progress";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";

function session(
  overrides: Partial<Parameters<typeof hasCurrentShopify>[0]> = {},
): Parameters<typeof hasCurrentShopify>[0] {
  return {
    id: SESSION_ID,
    mode: "reconnect",
    reconnectCompletedAt: null,
    shopify: [],
    ...overrides,
  };
}

const previousStore = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: "30000000-0000-4000-8000-000000000001",
};

describe("Shopify onboarding completion", () => {
  it("requires the persisted reconnect marker even when a previous store is visible", () => {
    expect(hasCurrentShopify(session({ shopify: [previousStore] }))).toBe(false);
    expect(
      hasCurrentShopify(
        session({
          shopify: [previousStore],
          reconnectCompletedAt: "2026-08-13T14:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("accepts only a store saved by the current add-assets session", () => {
    expect(
      hasCurrentShopify(
        session({ mode: "add_assets", shopify: [previousStore] }),
      ),
    ).toBe(false);
    expect(
      hasCurrentShopify(
        session({
          mode: "add_assets",
          shopify: [{ ...previousStore, sessionId: SESSION_ID }],
        }),
      ),
    ).toBe(true);
  });
});
