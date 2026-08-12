import { describe, expect, it } from "vitest";

import type { AuditConnectionDTO } from "./connections";
import {
  getAuditConnectionSummary,
  visibleAuditConnections,
} from "./connection-summary";

function connection(
  overrides: Partial<AuditConnectionDTO> = {},
): AuditConnectionDTO {
  return {
    id: "connection-id",
    storeLabel: "Example store",
    status: "connected",
    inviteExpiresAt: null,
    failedAttempts: 0,
    shopifyName: "Example store",
    shopifyDomain: "example.myshopify.com",
    primaryDomain: "example.com",
    currency: "EUR",
    credentialHint: "client…hint",
    grantedScopes: ["read_orders"],
    scopeProfile: "orders",
    createdAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
    connectedAt: "2026-08-12T10:00:00.000Z",
    lastVerifiedAt: "2026-08-12T10:00:00.000Z",
    reviewedAt: null,
    revokedAt: null,
    lastErrorCode: null,
    needsReview: true,
    ...overrides,
  };
}

describe("audit connection summary", () => {
  it("excludes revoked stores from the visible connection list", () => {
    const connected = connection({ id: "connected" });
    const revoked = connection({
      id: "revoked",
      status: "revoked",
      revokedAt: "2026-08-12T11:00:00.000Z",
    });
    const waiting = connection({
      id: "waiting",
      status: "waiting",
      connectedAt: null,
      lastVerifiedAt: null,
      needsReview: false,
    });

    expect(visibleAuditConnections([connected, revoked, waiting])).toEqual([
      connected,
      waiting,
    ]);
  });

  it("counts only visible connections flagged for review as waiting on reviews", () => {
    const summary = getAuditConnectionSummary([
      connection({ id: "needs-review" }),
      connection({
        id: "reviewed",
        reviewedAt: "2026-08-12T11:00:00.000Z",
        needsReview: false,
      }),
      connection({
        id: "waiting",
        status: "waiting",
        connectedAt: null,
        lastVerifiedAt: null,
        needsReview: false,
      }),
      connection({
        id: "failed-waiting",
        status: "waiting",
        failedAttempts: 4,
        connectedAt: null,
        lastVerifiedAt: null,
        lastErrorCode: "invalid_credentials",
        needsReview: false,
      }),
      connection({
        id: "expired",
        status: "expired",
        inviteExpiresAt: "2026-08-11T10:00:00.000Z",
        connectedAt: null,
        lastVerifiedAt: null,
        needsReview: false,
      }),
      connection({
        id: "revoked-needs-review",
        status: "revoked",
        revokedAt: "2026-08-12T11:00:00.000Z",
        needsReview: true,
      }),
    ]);

    expect(summary).toEqual({
      connected: 2,
      waiting: 2,
      waitingOnReviews: 1,
    });
  });
});
