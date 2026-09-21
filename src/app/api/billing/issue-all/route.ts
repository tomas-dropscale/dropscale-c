import { NextResponse, type NextRequest } from "next/server";

import {
  purgeAdminAccountRevenue,
  syncCommissionLedger,
} from "@/lib/admin/commission-sync";
import {
  issueClosedBillingWeekBatch,
  type BillingBatchResult,
} from "@/lib/billing/invoices";
import { billingIssuanceEnabled } from "@/lib/billing/issuance-gate";
import {
  billingEvidenceIsReady,
  billingEvidenceReadyAt,
  closedWeekStarting,
  closedWeeks,
} from "@/lib/billing/weekly";
import { createServiceClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function summary(result: BillingBatchResult) {
  const alreadyIssued = result.issued.filter(
    (invoice) => invoice.alreadyIssued,
  ).length;
  return {
    issued: result.issued.length,
    newlyIssued: result.issued.length - alreadyIssued,
    alreadyIssued,
    noCharge: result.noCharge.length,
    blocked: result.blocked.length,
  };
}

/** POST - refresh and issue every eligible client for one confirmed closed week. */
export async function POST(request: NextRequest) {
  const { user, profile } = await getSessionProfile();
  if (!user) return response({ error: "Unauthorised." }, 401);
  if (profile?.role !== "admin") return response({ error: "Forbidden." }, 403);
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);
  if (!billingIssuanceEnabled()) {
    return response({ error: "Billing issuance is disabled." }, 503);
  }

  const now = new Date();
  const rawBody = await request.text();
  let period;
  if (rawBody.length === 0) {
    // Keep older open dashboards working. Updated dialogs pin their selection.
    period = closedWeeks(now, 1)[0];
  } else {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return response({ error: "Invalid JSON request." }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("periodStart" in body) ||
      typeof body.periodStart !== "string" ||
      Object.keys(body).length !== 1
    ) {
      return response({ error: "A periodStart date is required." }, 400);
    }
    period = closedWeekStarting(body.periodStart, now);
    if (!period) {
      return response(
        { error: "Select a fully closed Monday-to-Sunday week." },
        422,
      );
    }
  }
  if (!period) {
    return response({ error: "No closed billing week is available." }, 409);
  }
  if (!billingEvidenceIsReady(period.end, now)) {
    return response(
      {
        error: "Google's Sunday spend is still settling.",
        readyAt: billingEvidenceReadyAt(period.end).toISOString(),
      },
      409,
    );
  }

  const service = createServiceClient();
  if (!service) return response({ error: "Billing is not configured." }, 503);

  let syncError: string | null = null;
  try {
    await purgeAdminAccountRevenue({ force: true, client: service, period });
    await syncCommissionLedger({ force: true, client: service, period });
  } catch (error) {
    console.error("Exact pre-invoice Google refresh failed:", error);
    syncError =
      "Some Google Ads accounts could not be refreshed. Clients with existing complete evidence were still processed.";
  }

  try {
    const result = await issueClosedBillingWeekBatch({
      periodStart: period.start,
      issuedBy: profile.id,
      client: service,
    });
    const counts = summary(result);
    if (result.blocked.length > 0) {
      // "13 blocked" alone is undiagnosable from the UI or the logs; the
      // per-client codes are the difference between a stuck week and a click.
      console.error(
        "Issue-all blocked:",
        JSON.stringify(
          result.blocked.map(({ clientName, code }) => ({ clientName, code })),
        ),
      );
    }
    return response({
      ok: true,
      status: syncError || counts.blocked > 0 ? "partial" : "succeeded",
      syncError,
      period: result.period,
      summary: counts,
      issued: result.issued,
      noCharge: result.noCharge,
      blocked: result.blocked,
    });
  } catch (error) {
    console.error("Bulk invoice issue failed before client processing:", error);
    return response(
      {
        error:
          "Invoices could not be processed. No unverified client was issued.",
        syncError,
      },
      500,
    );
  }
}
