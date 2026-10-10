import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * Historical closures explicitly approved by the owner. The ordinary end RPC
 * requires a contemporaneous Google counter: never invent one for a past date.
 * Keep these holds until a reviewed historical-end database model replaces them.
 * Every later cycle gets the existing durable, database-enforced skip receipt.
 */
const REVIEWED_SERVICE_ENDS = [{
  clientId: "927cbac3-8121-456b-9d19-1e7d5c62184a",
  lastServiceDay: "2026-09-29",
  reviewedBy: "75a7786a-a66e-4f75-b559-3a37ac9cb1cb",
  reason: "Owner confirmed on 2026-10-10: service ended 2026-09-29 inclusive. Final invoice O7NF1GF9-0031 corrected separately to EUR 69.60. No further weekly invoices.",
}] as const;

export function reviewedServiceEnd(clientId: string) {
  return REVIEWED_SERVICE_ENDS.find(end => end.clientId === clientId) ?? null;
}

export function serviceEndBlocksNewInvoice(clientId: string, periodEnd: string) {
  const end = reviewedServiceEnd(clientId);
  return end !== null && periodEnd > end.lastServiceDay;
}

export async function ensureServiceEndCycleSkip(
  service: SupabaseClient<Database>, clientId: string, periodStart: string, periodEnd: string,
): Promise<boolean> {
  const end = reviewedServiceEnd(clientId);
  // The partial closing week has a separately reviewed invoice correction.
  if (!end || periodStart <= end.lastServiceDay) return false;
  const { data, error } = await service.rpc("skip_billing_cycle", {
    p_client_id: clientId, p_period_start: periodStart, p_period_end: periodEnd,
    p_reason: end.reason, p_created_by: end.reviewedBy,
  });
  const row = data?.[0];
  if (error || !row || row.client_id !== clientId || row.period_start !== periodStart || row.period_end !== periodEnd) {
    throw new Error("Service has ended; the no-charge receipt could not be confirmed. Issuance is blocked.");
  }
  return true;
}
