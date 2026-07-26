import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { setDefaultPaymentMethod, verifyWebhookSignature } from "@/lib/stripe/client";

/**
 * Stripe → us. The ONLY writer of payment state.
 *
 * A browser can never mark an invoice paid: this route is the single path for
 * that, and it refuses anything that doesn't carry a valid signature over the
 * raw body. It runs with the service role because Stripe has no session — the
 * signature IS the authentication.
 */

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook secret not configured." }, { status: 500 });
  }

  // Raw text, not request.json(): the signature covers the exact bytes sent.
  const payload = await request.text();
  const valid = await verifyWebhookSignature(
    payload,
    request.headers.get("stripe-signature"),
    secret,
  );
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const event = JSON.parse(payload) as {
    type: string;
    data: { object: Record<string, unknown> };
  };
  const object = event.data.object;

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json({ error: "Service credentials missing." }, { status: 500 });
  }

  const stripeInvoiceId = typeof object.id === "string" ? object.id : null;
  const now = new Date().toISOString();

  switch (event.type) {
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      if (stripeInvoiceId) {
        await supabase
          .from("invoices")
          .update({ status: "paid", paid_at: now, updated_at: now })
          .eq("stripe_invoice_id", stripeInvoiceId);
      }
      break;
    }

    case "invoice.finalized":
    case "invoice.payment_failed": {
      if (stripeInvoiceId) {
        await supabase
          .from("invoices")
          .update({
            status: "open",
            stripe_hosted_url:
              typeof object.hosted_invoice_url === "string" ? object.hosted_invoice_url : null,
            updated_at: now,
          })
          .eq("stripe_invoice_id", stripeInvoiceId);
      }
      break;
    }

    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      if (stripeInvoiceId) {
        await supabase
          .from("invoices")
          .update({
            status: event.type === "invoice.voided" ? "void" : "uncollectible",
            updated_at: now,
          })
          .eq("stripe_invoice_id", stripeInvoiceId);
      }
      break;
    }

    case "checkout.session.completed": {
      // A card was saved — make it the default so future weeks settle on their
      // own, which is the whole point of the setup flow.
      const customer = typeof object.customer === "string" ? object.customer : null;
      const setupIntent = typeof object.setup_intent === "string" ? object.setup_intent : null;
      if (customer && setupIntent) {
        try {
          const intent = (await (
            await fetch(`https://api.stripe.com/v1/setup_intents/${setupIntent}`, {
              headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
            })
          ).json()) as { payment_method?: string };
          if (intent.payment_method) {
            await setDefaultPaymentMethod(customer, intent.payment_method);
          }
        } catch (error) {
          console.error("Stripe: could not set default payment method:", error);
        }
      }
      break;
    }

    default:
      break; // Everything else is noise for our purposes.
  }

  // Always 200 on a verified event: a non-2xx makes Stripe retry an event we
  // simply don't handle.
  return NextResponse.json({ received: true });
}
