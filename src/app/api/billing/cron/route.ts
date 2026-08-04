import { NextResponse, type NextRequest } from "next/server";
import { syncCommissionLedger } from "@/lib/admin/commission-sync";
import {
  automationTargets,
  beginBillingAutomationRun,
  claimBillingAutomationItems,
  finishBillingAutomationRun,
  recordBillingAutomationOutcomes,
  seedBillingAutomationItems,
} from "@/lib/billing/automation-receipts";
import { automaticBillingIssuanceEnabled } from "@/lib/billing/issuance-gate";
import { createServiceClient } from "@/lib/supabase/service";
import {
  type AutomaticBillingResult,
  issueAutomaticClosedWeeks,
  reconcileInvoices,
} from "@/lib/billing/invoices";
import { addDays, mondayOf } from "@/lib/billing/weekly";

/**
 * Protected automatic billing run. Monday's worker reaches it only after the
 * exact closed-week Google refresh; daily retries are safe because database
 * snapshots, issue leases and Stripe idempotency all use stable invoice keys.
 */
export const dynamic = "force-dynamic";

type ExactWeekHealing = {
  requested: number;
  completed: number;
  errors: { periodStart: string; message: string }[];
};

function emptyAutomaticResult(): AutomaticBillingResult {
  return {
    periodsChecked: 0,
    historicalRolloversChecked: 0,
    clientsChecked: 0,
    issued: 0,
    noCharge: 0,
    alreadySettled: 0,
    blocked: 0,
    exactRefreshPeriods: [],
    errors: [],
    outcomes: [],
  };
}

function mergeAutomaticResults(
  total: AutomaticBillingResult,
  batch: AutomaticBillingResult,
): AutomaticBillingResult {
  const exactRefreshPeriods = [
    ...total.exactRefreshPeriods,
    ...batch.exactRefreshPeriods,
  ].filter(
    (period, index, periods) =>
      periods.findIndex((candidate) => candidate.start === period.start) === index,
  );
  return {
    periodsChecked: total.periodsChecked + batch.periodsChecked,
    historicalRolloversChecked:
      total.historicalRolloversChecked + batch.historicalRolloversChecked,
    clientsChecked: total.clientsChecked + batch.clientsChecked,
    issued: total.issued + batch.issued,
    noCharge: total.noCharge + batch.noCharge,
    alreadySettled: total.alreadySettled + batch.alreadySettled,
    blocked: total.blocked + batch.blocked,
    exactRefreshPeriods,
    errors: [...total.errors, ...batch.errors],
    outcomes: [...total.outcomes, ...batch.outcomes],
  };
}

async function healExactGoogleWeeks(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  periods: AutomaticBillingResult["exactRefreshPeriods"],
): Promise<ExactWeekHealing> {
  const healing: ExactWeekHealing = {
    requested: periods.length,
    completed: 0,
    errors: [],
  };

  // Oldest first: a week that suffered a transient Monday failure must not be
  // starved forever as newer weeks close. The forced exact period writes the
  // same immutable Google proof that calculateWeek requires before issuance.
  for (const period of [...periods].sort((left, right) =>
    left.start.localeCompare(right.start),
  )) {
    try {
      await syncCommissionLedger({ force: true, client: supabase, period });
      healing.completed += 1;
    } catch (error) {
      healing.errors.push({
        periodStart: period.start,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return healing;
}

function finalIssuanceResult(
  initial: AutomaticBillingResult,
  retry: AutomaticBillingResult | null,
): AutomaticBillingResult {
  if (!retry) return initial;
  return {
    ...retry,
    periodsChecked: initial.periodsChecked + retry.periodsChecked,
    historicalRolloversChecked:
      initial.historicalRolloversChecked + retry.historicalRolloversChecked,
    clientsChecked: initial.clientsChecked + retry.clientsChecked,
    // The retry reports each durable item's final position. `issued` is an
    // event count, so preserve invoices successfully emitted in either pass.
    issued: initial.issued + retry.issued,
    errors: [...initial.errors, ...retry.errors],
  };
}

function assertExactOutcomeCoverage(
  targets: { itemId: string }[],
  outcomes: AutomaticBillingResult["outcomes"],
): void {
  const expected = new Set(targets.map((target) => target.itemId));
  const received = new Set(outcomes.map((outcome) => outcome.itemId));
  if (
    outcomes.length !== targets.length ||
    received.size !== expected.size ||
    [...expected].some((itemId) => !received.has(itemId))
  ) {
    throw new Error(
      "Automatic billing did not produce exactly one durable outcome per claim.",
    );
  }
}

async function run(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  let runId: string | null = null;
  let issuance = emptyAutomaticResult();
  const healing: ExactWeekHealing = { requested: 0, completed: 0, errors: [] };
  let reconciliation = { checked: 0, updated: 0, errors: [] as string[] };

  try {
    const automationRun = await beginBillingAutomationRun(
      supabase,
      automaticBillingIssuanceEnabled(),
    );
    runId = automationRun.id;
    await seedBillingAutomationItems(
      supabase,
      runId,
      addDays(mondayOf(new Date()), -1),
    );

    let includeHistoricalRollovers = true;
    for (;;) {
      const claimed = await claimBillingAutomationItems(supabase, runId);
      if (claimed.length === 0 && !includeHistoricalRollovers) break;

      const targets = automationTargets(claimed);
      const initialIssuance = await issueAutomaticClosedWeeks(supabase, {
        targets,
        includeHistoricalRollovers,
      });
      includeHistoricalRollovers = false;

      const batchHealing = await healExactGoogleWeeks(
        supabase,
        initialIssuance.exactRefreshPeriods,
      );
      healing.requested += batchHealing.requested;
      healing.completed += batchHealing.completed;
      healing.errors.push(...batchHealing.errors);

      const retryIssuance =
        batchHealing.requested > 0
          ? await issueAutomaticClosedWeeks(supabase, {
              targets,
              includeHistoricalRollovers: false,
            })
          : null;
      const finalBatch = finalIssuanceResult(
        initialIssuance,
        retryIssuance,
      );
      assertExactOutcomeCoverage(targets, finalBatch.outcomes);
      await recordBillingAutomationOutcomes(
        supabase,
        runId,
        finalBatch.outcomes,
      );
      issuance = mergeAutomaticResults(issuance, finalBatch);

      if (claimed.length === 0) break;
    }

    reconciliation = await reconcileInvoices(supabase);
    const errorCount =
      issuance.errors.length +
      healing.errors.length +
      reconciliation.errors.length;
    const runStatus =
      errorCount === 0
        ? issuance.blocked > 0
          ? "partial"
          : "succeeded"
        : issuance.issued + issuance.noCharge + issuance.alreadySettled > 0
          ? "partial"
          : "failed";
    await finishBillingAutomationRun(supabase, runId, {
      status: runStatus,
      historicalRolloversChecked: issuance.historicalRolloversChecked,
      exactRefreshRequested: healing.requested,
      exactRefreshCompleted: healing.completed,
      reconciliationChecked: reconciliation.checked,
      reconciliationUpdated: reconciliation.updated,
      errorCount,
    });

    const ok = errorCount === 0;
    return NextResponse.json(
      {
        ok,
        runId,
        ranAt: new Date().toISOString(),
        issuance,
        healing,
        reconciliation,
      },
      { status: ok ? 200 : 502 },
    );
  } catch (error) {
    console.error("Automatic billing run failed:", error);
    if (runId) {
      try {
        await finishBillingAutomationRun(supabase, runId, {
          status: "failed",
          historicalRolloversChecked: issuance.historicalRolloversChecked,
          exactRefreshRequested: healing.requested,
          exactRefreshCompleted: healing.completed,
          reconciliationChecked: reconciliation.checked,
          reconciliationUpdated: reconciliation.updated,
          errorCount: Math.max(
            1,
            issuance.errors.length +
              healing.errors.length +
              reconciliation.errors.length,
          ),
        });
      } catch (finishError) {
        console.error("Could not close failed billing run:", finishError);
      }
    }
    return NextResponse.json(
      { ok: false, runId, error: "Automatic billing run failed." },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  return run(request);
}
