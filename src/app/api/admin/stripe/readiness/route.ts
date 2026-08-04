import { NextResponse } from "next/server";

import { billingIssuanceEnabled } from "@/lib/billing/issuance-gate";
import { checkStripeReadiness } from "@/lib/stripe/client";
import { getSessionProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/** GET - admin-only, side-effect-free readiness evidence for live Stripe. */
export async function GET() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const stripe = await checkStripeReadiness();
  const webhookSecretConfigured = Boolean(
    process.env.STRIPE_WEBHOOK_SECRET?.trim(),
  );
  const serviceRoleConfigured = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
  const issuanceEnabled = billingIssuanceEnabled();
  const permissionsReady = Object.values(stripe.permissions).every(Boolean);

  return NextResponse.json(
    {
      ready:
        stripe.liveMode &&
        permissionsReady &&
        webhookSecretConfigured &&
        serviceRoleConfigured,
      keyMode: stripe.keyMode,
      liveMode: stripe.liveMode,
      webhookSecretConfigured,
      serviceRoleConfigured,
      issuanceEnabled,
      permissions: stripe.permissions,
      limitations: stripe.limitations,
    },
    { headers: NO_STORE_HEADERS },
  );
}
