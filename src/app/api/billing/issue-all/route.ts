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

/** POST - refresh and issue every eligible client for the latest closed week. */
export async function POST(request: NextRequest) {
  const { user, profile } = await getSessionProfile();
  if (!user) return response({ error: "Unauthorised." }, 401);
  if (profile?.role !== "admin") return response({ error: "Forbidden." }, 403);
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);
  if ((await request.text()).length !== 0) {
    return response({ error: "This action does not accept a body." }, 400);
  }
  if (!billingIssuanceEnabled()) {
    return response({ error: "Billing issuance is disabled." }, 503);
  }

  const period = closedWeeks(new Date(), 1)[0];
  if (!period) {
    return response({ error: "No closed billing week is available." }, 409);
  }
  if (!billingEvidenceIsReady(period.end)) {
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
