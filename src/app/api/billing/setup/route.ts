import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { createCustomer, createSetupSession, stripeConfigured } from "@/lib/stripe/client";

/**
 * POST — start Stripe Checkout in `setup` mode so this client can save a card.
 * With one on file, later invoices settle without anyone clicking a link.
 *
 * Rides the caller's own session and targets the ACTIVE workspace: a sócio may
 * put the business's card on file, but the customer id is looked up from that
 * workspace's row, never posted in.
 */
export async function POST() {
  const { owner: client } = await getWorkspaceContext();
  if (!client) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: "Payments aren't configured on this server yet." },
      { status: 503 },
    );
  }

  const supabase = await createClient();

  let customerId = client.stripe_customer_id;
  if (!customerId) {
    try {
      customerId = await createCustomer({
        email: client.email,
        name: client.full_name,
        clientId: client.id,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Stripe call failed." },
        { status: 502 },
      );
    }
    // Via the RPC, not a direct UPDATE: portal_clients writes stay "your own
    // row only", and this is the single column a sócio is allowed to set on the
    // owner's (migration 0015).
    await supabase.rpc("set_workspace_stripe_customer", {
      p_client_id: client.id,
      p_customer_id: customerId,
    });
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

  try {
    const session = await createSetupSession({
      customerId,
      returnUrl: `${origin}/dashboard/payments`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe call failed." },
      { status: 502 },
    );
  }
}
