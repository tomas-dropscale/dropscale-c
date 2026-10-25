import type { InvoiceLine } from "@/lib/supabase/types";

/**
 * Explicit owner authorization, 2026-10-25: add EUR 34.80 for Customer service
 * to Lourenço's Google Ads invoice issued on 26 October (19–25 October cycle).
 * This is a single-cycle supplement, not a recurring change to the agency fee.
 * Keep the matching database allowlist in migration 0105 in sync.
 */
const LOURENCO_CUSTOMER_SERVICE = {
  clientId: "5107292f-1bf6-42a4-ba8d-dc1d730d4044",
  periodStart: "2026-10-19",
  extraId: "lourenco-customer-service-2026-10-26",
  cents: 3480,
} as const;

export function reviewedWeeklyExtras(
  clientId: string,
  periodStart: string,
): InvoiceLine[] {
  if (
    clientId !== LOURENCO_CUSTOMER_SERVICE.clientId ||
    periodStart !== LOURENCO_CUSTOMER_SERVICE.periodStart
  ) return [];

  return [{
    kind: "service",
    extraId: LOURENCO_CUSTOMER_SERVICE.extraId,
    label: "Customer service",
    amount: LOURENCO_CUSTOMER_SERVICE.cents / 100,
    accountId: null,
  }];
}
