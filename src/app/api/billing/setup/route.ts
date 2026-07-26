import { NextResponse } from "next/server";
import { createClient, getSessionClient } from "@/lib/supabase/server";
import { createCustomer, createSetupSession, stripeConfigured } from "@/lib/stripe/client";

/**
 * POST — start Stripe Checkout in `setup` mode so this client can save a card.
 * With one on file, later invoices settle without anyone clicking a link.
 *
 * Rides the client's own session: a client can only ever set up their own
 * billing, and the customer id is looked up from their row, never posted in.
 */
export async function POST() {
  const { client } = await getSessionClient();
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
    await supabase
      .from("portal_clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
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
