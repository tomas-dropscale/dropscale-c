import { NextResponse, type NextRequest } from "next/server";
import {
  beginBillingAutomationRun,
  claimExpiredSkippedBillingItems,
  finishBillingAutomationRun,
  recordBillingAutomationOutcomes,
  skippedBillingRecoveryOutcome,
} from "@/lib/billing/automation-receipts";
import { billingRecoveryEnabled } from "@/lib/billing/issuance-gate";
import { reconcileInvoices } from "@/lib/billing/invoices";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Default cron work is Stripe-state reconciliation only. The sole recovery
 * mode is explicit, separately armed and purpose-bound in SQL to expired
 * skipped-cycle claims; it cannot seed or consume the general billing queue.
 */
export const dynamic = "force-dynamic";

function authorised(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return null;
}

async function reconciliation() {
  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }
  const result = await reconcileInvoices(supabase);
  return NextResponse.json(
    { ok: result.errors.length === 0, ranAt: new Date().toISOString(), ...result },
    { status: result.errors.length === 0 ? 200 : 502 },
  );
}

async function recoverSkippedClaims() {
  if (!billingRecoveryEnabled()) {
    return NextResponse.json(
      { error: "Billing recovery is not armed." },
      { status: 503 },
    );
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  let runId: string | null = null;
  let recovered = 0;
  try {
    // Always a non-issuance run. SQL rejects this recovery claim if that bit
    // is ever changed and rejects issued outcomes from non-issuance runs.
    const run = await beginBillingAutomationRun(supabase);
    runId = run.id;
    const claimed = await claimExpiredSkippedBillingItems(supabase, run.id, 2);
    const outcomes: Awaited<
      ReturnType<typeof skippedBillingRecoveryOutcome>
    >[] = [];
    for (const item of claimed) {
      outcomes.push(await skippedBillingRecoveryOutcome(supabase, item));
    }
    await recordBillingAutomationOutcomes(supabase, run.id, outcomes);
    recovered = outcomes.length;
    await finishBillingAutomationRun(supabase, run.id, {
      status: "succeeded",
      reconciliationChecked: 0,
      reconciliationUpdated: 0,
      errorCount: 0,
    });

    return NextResponse.json({
      ok: true,
      runId,
      recovered,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    if (runId) {
      try {
        await finishBillingAutomationRun(supabase, runId, {
          status: recovered > 0 ? "partial" : "failed",
          reconciliationChecked: 0,
          reconciliationUpdated: 0,
          errorCount: 1,
        });
      } catch (finishError) {
        console.error("Could not close failed billing recovery run:", finishError);
      }
    }
    console.error("Skipped-cycle billing recovery failed:", error);
    return NextResponse.json(
      { ok: false, runId, error: "Billing recovery failed." },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  const denied = authorised(request);
  if (denied) return denied;
  return reconciliation();
}

export async function POST(request: NextRequest) {
  const denied = authorised(request);
  if (denied) return denied;
  return request.nextUrl.searchParams.get("mode") === "recovery"
    ? recoverSkippedClaims()
    : reconciliation();
}
