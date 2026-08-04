import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { ReferralCard, type ReferralStatus } from "@/components/portal/referral-card";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";
import {
  manualReferralRateOnDay,
  REFERRAL_FLOOR_RATE,
} from "@/lib/billing/referrals";
import { fetchManualReferralRateSchedule } from "@/lib/billing/referral-rate-schedule";
import { isoDay } from "@/lib/billing/weekly";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.referrals.navLabel };
}

/**
 * Settings → Affiliates: attribution, manual review state and the sealed rate
 * currently in force for the workspace.
 *
 * A tab of its own rather than a card on personal settings: this is the only
 * screen in the portal that pays the client something, and burying it under a
 * billing profile is the surest way for nobody to ever use it.
 */
export default async function AffiliatesPage() {
  const [{ viewer, active, owner }, { d }] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
  ]);
  if (!viewer || !active) return null; // gate already handled this

  const supabase = await createClient();
  const [{ data: referred, error: referralError }, { data: rateRows, error: rateError }, schedule] = await Promise.all([
    // Who the WORKSPACE OWNER brought in and whether the manual term is active,
    // scheduled or awaiting review. The definer returns only name + status;
    // no referred client's spend, evidence or account identity crosses RLS.
    supabase.rpc("referral_summary", { p_client_id: active.id }),
    supabase
      .from("ad_accounts")
      .select("commission_rate, list_commission_rate, revenue_share_enabled")
      .eq("client_id", active.id),
    fetchManualReferralRateSchedule(active.id),
  ]);
  if (referralError) throw new Error("Could not load the manual referral summary", { cause: referralError });
  if (rateError) throw new Error("Could not verify the account list rate", { cause: rateError });

  // Stores can sit on different deals, so there is no single "your fee". Show
  // the highest list price rather than an average nobody is actually billed at;
  // with one store — the usual case — it is exact.
  const rates = rateRows ?? [];
  const compatibleListRate =
    rates.length > 0 &&
    rates.every(
      (row) =>
        Number(row.list_commission_rate) === 10 &&
        !row.revenue_share_enabled,
    );
  // The mutable per-account cache is presentation-only. This card resolves
  // the sealed client-wide term for Lisbon today, including a scheduled term
  // that became effective even if a maintenance refresh was delayed.
  const listRate = compatibleListRate ? 10 : null;
  const effectiveRate = compatibleListRate
    ? manualReferralRateOnDay(isoDay(new Date()), schedule)
    : null;

  return (
    <PageContainer title={d.referrals.navLabel} description={d.referrals.subtitle}>
      <div className="max-w-[720px]">
        <ReferralCard
          code={active.isOwner ? viewer.referral_code : (owner?.referral_code ?? null)}
          referred={(referred ?? []).map((client) => ({
            name: client.name,
            status: client.status as ReferralStatus,
          }))}
          listRate={listRate}
          effectiveRate={effectiveRate}
          floorRate={REFERRAL_FLOOR_RATE}
        />
      </div>
    </PageContainer>
  );
}
