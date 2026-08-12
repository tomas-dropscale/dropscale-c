import { describe, expect, it, vi } from "vitest";

import {
  LARA_AUDIT_CONNECTION_ID,
  requestReadOnlyLaraAudit,
  summariseAuditCollection,
} from "./audit-read-only-client";

const RUN_ID = "40000000-0000-4000-8000-000000000010";

function completedBody() {
  return {
    ok: true,
    runId: RUN_ID,
    state: "completed",
    summary: {
      schemaVersion: "shopify-audit-baseline-v2",
      auditStatus: "complete",
      generatedAt: "2026-08-12T16:30:00.000Z",
      modules: {
        shopIdentity: { status: "complete", requests: 1 },
        products: { status: "blocked_missing_scope", missingScopes: ["read_products"] },
        theme: { status: "failed", errorCode: "theme_missing" },
      },
      counts: {
        productsCount: { count: 1_448, precision: "EXACT" },
        productVariantsCount: { count: 38_068, precision: "AT_LEAST" },
      },
      captured: {
        priorityProductsFound: 1,
        priorityProductsRequested: 2,
        policies: 1,
        pages: 2,
        menus: 1,
        themeSourceFilesMatched: 1,
      },
      shopIdentity: {
        contactEmail: "private@example.com",
        shopAddress: { phone: "+351000000000" },
      },
      rawSecret: "client_secret=must-not-leak",
    },
  };
}

describe("read-only audit UI client", () => {
  it("keeps only a bounded aggregate summary from the collector artifact", () => {
    const summary = summariseAuditCollection(completedBody());

    expect(summary).toEqual({
      runId: RUN_ID,
      state: "completed",
      generatedAt: "2026-08-12T16:30:00.000Z",
      errorCode: null,
      modules: { total: 3, complete: 1, blocked: 1, failed: 1 },
      catalog: {
        products: 1_448,
        variants: 38_068,
        productsExact: true,
        variantsExact: false,
      },
      captured: {
        priorityProductsFound: 1,
        priorityProductsRequested: 2,
        policies: 1,
        pages: 2,
        menus: 1,
        themeSourceFilesMatched: 1,
      },
    });
    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain("private@example.com");
    expect(rendered).not.toContain("+351000000000");
    expect(rendered).not.toContain("client_secret");
  });

  it("sends only the fixed confirmation to the hard-pinned route", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(completedBody(), {
        status: 200,
        headers: { "cache-control": "private, no-store" },
      }),
    );

    const result = await requestReadOnlyLaraAudit(
      LARA_AUDIT_CONNECTION_ID,
      fetcher,
    );

    expect(result).toEqual({
      ok: true,
      summary: summariseAuditCollection(completedBody()),
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/admin/audit/connections/${LARA_AUDIT_CONNECTION_ID}/collect`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "collect-read-only" }),
      },
    );
  });

  it("refuses any connection other than Lara before making a request", async () => {
    const fetcher = vi.fn();
    const result = await requestReadOnlyLaraAudit(
      "40000000-0000-4000-8000-000000000099",
      fetcher,
    );

    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains a sanitized failed run summary without exposing the response body", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          runId: RUN_ID,
          state: "failed",
          errorCode: "runtime_scope_mismatch",
          error: "client_secret=must-not-leak",
        },
        { status: 502 },
      ),
    );

    const result = await requestReadOnlyLaraAudit(
      LARA_AUDIT_CONNECTION_ID,
      fetcher,
    );

    expect(result).toEqual({
      ok: false,
      message:
        "The read-only audit stopped safely before completing. No Shopify data was changed.",
      summary: {
        runId: RUN_ID,
        state: "failed",
        generatedAt: null,
        errorCode: "runtime_scope_mismatch",
        modules: { total: 0, complete: 0, blocked: 0, failed: 0 },
        catalog: {
          products: null,
          variants: null,
          productsExact: null,
          variantsExact: null,
        },
        captured: {
          priorityProductsFound: 0,
          priorityProductsRequested: 0,
          policies: 0,
          pages: 0,
          menus: 0,
          themeSourceFilesMatched: 0,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("client_secret");
  });

  it("rejects malformed run identifiers and unrecognised states", () => {
    expect(
      summariseAuditCollection({ runId: "not-a-uuid", state: "completed" }),
    ).toBeNull();
    expect(
      summariseAuditCollection({ runId: RUN_ID, state: "running" }),
    ).toBeNull();
  });

  it("represents an existing in-progress run without inventing evidence", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { ok: true, runId: RUN_ID, state: "in_progress" },
        { status: 202 },
      ),
    );
    const result = await requestReadOnlyLaraAudit(
      LARA_AUDIT_CONNECTION_ID,
      fetcher,
    );
    expect(result).toMatchObject({
      ok: true,
      summary: {
        runId: RUN_ID,
        state: "in_progress",
        modules: { total: 0 },
        catalog: { products: null, variants: null },
      },
    });
  });
});
