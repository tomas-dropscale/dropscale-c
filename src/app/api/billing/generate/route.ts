import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { BillingIssueError, issueClientWeek } from "@/lib/billing/invoices";
import { billingIssuanceEnabled } from "@/lib/billing/issuance-gate";

type IssueBody = {
  clientId?: unknown;
  periodStart?: unknown;
  expectedAmount?: unknown;
  expectedReviewToken?: unknown;
};

/** POST - review-confirmed issue of exactly one client's closed weekly fee. */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  // Keep the gate behind admin authentication so it does not disclose
  // operational state publicly, but ahead of every service-role or Stripe-
  // backed operation. Unset and malformed values fail closed in the helper.
  if (!billingIssuanceEnabled()) {
    return NextResponse.json(
      { error: "Billing issuance is disabled." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as IssueBody | null;
  if (
    typeof body?.clientId !== "string" ||
    typeof body.periodStart !== "string" ||
    typeof body.expectedAmount !== "number" ||
    typeof body.expectedReviewToken !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          "clientId, periodStart, numeric expectedAmount and expectedReviewToken are required.",
      },
      { status: 422 },
    );
  }

  // The browser proves who approved the invoice, but it never receives write
  // access to Stripe/payment state. All financial mutations run through the
  // server role after this explicit admin check.
  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  try {
    const invoice = await issueClientWeek({
      clientId: body.clientId,
      periodStart: body.periodStart,
      expectedAmount: body.expectedAmount,
      expectedReviewToken: body.expectedReviewToken,
      issuedBy: profile.id,
      client: supabase,
    });
    return NextResponse.json({ ok: true, invoice });
  } catch (error) {
    if (error instanceof BillingIssueError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.preview ? { preview: error.preview } : {}),
        },
        { status: error.status },
      );
    }
    console.error("Manual invoice issue failed:", error);
    return NextResponse.json({ error: "Could not issue the invoice." }, { status: 500 });
  }
}
