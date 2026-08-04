import { NextResponse } from "next/server";

/**
 * Card-on-file and automatic charging are intentionally disabled for the
 * manual agency-billing MVP. Clients pay each approved EUR invoice through
 * Stripe's Hosted Invoice Page instead.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Saving a card is disabled. Open an issued invoice in Payments to pay securely on Stripe.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
