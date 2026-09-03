import "server-only";

import type { GaqlRow } from "@/lib/google-ads/client";
import { fetchGoogleAdsDailyBreakdown } from "@/lib/windsor/client";

/**
 * A billing-boundary capture read backed by WINDSOR instead of the direct
 * Google Ads API.
 *
 * The boundary captures (Stop counting, billing starts) were built on the
 * agency service account reading Google directly. The agency now operates
 * through Windsor, and the direct grant is not maintained — when it lapses,
 * every capture 502s and no store can close or open billing. Windsor carries
 * the same account-level daily counter (it is what the whole reporting side
 * already trusts), so it serves as the capture's fallback instrument.
 *
 * Two honest differences from the direct read, both acceptable here:
 *  - Windsor's counter can trail Google's live one by minutes. A boundary is
 *    captured with campaigns PAUSED (the handover runbook requires it), where
 *    the counter is static and the lag is worth zero. On an active account
 *    the captured end can only be LOW, which under-bills the closing store's
 *    final day - it never double-bills.
 *  - Windsor cannot state the account's currency/time zone for an idle day,
 *    so the caller supplies both from the immutable boundary already on file
 *    (the billing start), and any Windsor row that contradicts them fails the
 *    capture instead of silently drifting identity.
 *
 * This module implements the capture functions' injectable `search` contract,
 * answering only the two exact queries they issue; anything else is a bug.
 */

const DAY_RANGE = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/;

function dashed(customerId: string): string {
  const digits = customerId.replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error("Invalid Google Ads customer id for a Windsor capture.");
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Exact micros from Windsor's six-decimal money contract. */
function spendToMicros(spend: number): string {
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error("Windsor returned an invalid spend value for a capture.");
  }
  return String(Math.round(spend * 1e6));
}

export function windsorCaptureSearch(identity: {
  customerId: string;
  timeZone: string;
  currency: string;
}): (customerId: string, query: string) => Promise<GaqlRow[]> {
  const expected = identity.customerId.replace(/\D/g, "");

  return async (customerId: string, query: string): Promise<GaqlRow[]> => {
    if (customerId.replace(/\D/g, "") !== expected) {
      throw new Error("Windsor capture asked about a different customer.");
    }

    if (query.includes("customer.currency_code")) {
      // Identity comes from the immutable boundary on file, never guessed
      // from spend rows that may not exist on an idle day.
      return [
        {
          customer: {
            id: expected,
            currencyCode: identity.currency,
            timeZone: identity.timeZone,
          },
        },
      ];
    }

    if (query.includes("metrics.cost_micros")) {
      const range = query.match(DAY_RANGE);
      if (!range) throw new Error("Windsor capture received an unexpected spend query.");
      const [, from, to] = range;
      const days = await fetchGoogleAdsDailyBreakdown(dashed(expected), from, to);
      return days.map((day) => {
        if (day.currency !== identity.currency || day.timeZone !== identity.timeZone) {
          throw new Error(
            "Windsor reports a different account identity than the billing boundary on file.",
          );
        }
        return {
          customer: { id: day.customerId },
          segments: { date: day.date },
          metrics: { costMicros: spendToMicros(day.spend) },
        };
      });
    }

    throw new Error("Windsor capture received an unsupported query.");
  };
}
