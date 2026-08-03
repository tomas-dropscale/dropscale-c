import { NextResponse, type NextRequest } from "next/server";
import {
  allowedLocalStatusesForStripeUpdate,
  authoritativeInvoiceUpdate,
  assertStripeInvoiceMatchesLocal,
  getInvoice,
  stripeApiKeyMode,
  stripeInvoiceStatusDecision,
  verifyWebhookSignature,
  type StripeInvoiceRecipientExpectation,
} from "@/lib/stripe/client";
import {
  CALCULATION_VERSION,
  isManualAgencyCalculationVersion,
} from "@/lib/billing/weekly";
import { requireBillingRecipientSnapshot } from "@/lib/billing/review-token";
import { createServiceClient } from "@/lib/supabase/service";

type StripeWebhookEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

const RECONCILED_INVOICE_EVENTS = new Set([
  "invoice.created",
  "invoice.finalization_failed",
  "invoice.finalized",
  "invoice.marked_uncollectible",
  "invoice.overdue",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.sent",
  "invoice.updated",
  "invoice.voided",
  "invoice.will_be_due",
]);

function errorMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : "Unknown webhook processing error."
  ).slice(0, 1_000);
}

function stripeRecipientExpectation(
  value: unknown,
): StripeInvoiceRecipientExpectation {
  const recipient = requireBillingRecipientSnapshot(value);
  return {
    email: recipient.email,
    name: recipient.billingName ?? recipient.fallbackName,
    address: {
      line1: recipient.addressLine1,
      line2: recipient.addressLine2,
      city: recipient.addressCity,
      postal_code: recipient.addressPostalCode,
      state: recipient.addressState,
      country: recipient.addressCountry,
    },
    taxId: recipient.taxId,
  };
}

/**
 * Stripe → Dropscale. The raw-body signature authenticates the sender; the
 * durable event inbox makes retries safe and observable.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured." },
      { status: 500 },
    );
  }

  const payload = await request.text();
  const valid = await verifyWebhookSignature(
    payload,
    request.headers.get("stripe-signature"),
    secret,
  );
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(payload) as StripeWebhookEvent;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 },
    );
  }
  if (
    !event ||
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.created !== "number" ||
    typeof event.livemode !== "boolean" ||
    !Number.isInteger(event.created) ||
    event.created <= 0 ||
    !event.data ||
    typeof event.data.object !== "object" ||
    event.data.object === null
  ) {
    return NextResponse.json(
      { error: "Invalid Stripe event." },
      { status: 400 },
    );
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const keyMode = stripeApiKeyMode(stripeKey);
  if (!keyMode) {
    return NextResponse.json(
      { error: "Stripe API key not configured." },
      { status: 500 },
    );
  }
  if (process.env.NODE_ENV === "production" && keyMode !== "live") {
    return NextResponse.json(
      { error: "Production webhook requires a live Stripe API key." },
      { status: 500 },
    );
  }
  if (event.livemode !== (keyMode === "live")) {
    return NextResponse.json(
      { error: "Stripe mode mismatch." },
      { status: 400 },
    );
  }
  const stripeCreatedAt = new Date(event.created * 1000);
  if (Number.isNaN(stripeCreatedAt.getTime())) {
    return NextResponse.json(
      { error: "Invalid Stripe event timestamp." },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Service credentials missing." },
      { status: 500 },
    );
  }

  // Insert once. A duplicate whose first attempt failed remains unprocessed and
  // is deliberately attempted again below.
  const { error: inboxError } = await supabase
    .from("stripe_webhook_events")
    .upsert(
      {
        id: event.id,
        type: event.type,
        stripe_created_at: stripeCreatedAt.toISOString(),
        payload: event as unknown as Record<string, unknown>,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (inboxError) {
    return NextResponse.json(
      { error: "Could not persist Stripe event." },
      { status: 500 },
    );
  }

  const { data: inbox, error: inboxReadError } = await supabase
    .from("stripe_webhook_events")
    .select("processed_at")
    .eq("id", event.id)
    .maybeSingle();
  if (inboxReadError || !inbox) {
    return NextResponse.json(
      { error: "Could not read persisted Stripe event." },
      { status: 500 },
    );
  }
  if (inbox.processed_at) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const objectId =
      typeof event.data.object.id === "string" ? event.data.object.id : null;

    // All invoice events are reconciled from the current Stripe object. This
    // handles paid/finalised/failed/void events as well as future invoice event
    // types without trusting their delivery order or stale payload snapshot.
    if (RECONCILED_INVOICE_EVENTS.has(event.type) && objectId) {
      const remote = await getInvoice(objectId);
      const update = authoritativeInvoiceUpdate(
        remote,
        event.type,
        event.created,
      );

      const { data: byStripeId, error: byStripeIdError } = await supabase
        .from("invoices")
        .select(
          "id, client_id, stripe_invoice_id, status, amount, currency, calculation_version, billing_recipient",
        )
        .eq("stripe_invoice_id", remote.id)
        .maybeSingle();
      if (byStripeIdError) throw byStripeIdError;

      let local = byStripeId;
      const localId = remote.metadata?.dropscale_invoice_id;
      if (!local && localId) {
        const { data: byLocalId, error: byLocalIdError } = await supabase
          .from("invoices")
          .select(
            "id, client_id, stripe_invoice_id, status, amount, currency, calculation_version, billing_recipient",
          )
          .eq("id", localId)
          .maybeSingle();
        if (byLocalIdError) throw byLocalIdError;
        if (
          byLocalId?.stripe_invoice_id &&
          byLocalId.stripe_invoice_id !== remote.id
        ) {
          throw new Error(
            `Local invoice ${localId} is linked to a different Stripe invoice.`,
          );
        }
        if (
          byLocalId &&
          (!byLocalId.stripe_invoice_id ||
            byLocalId.stripe_invoice_id === remote.id) &&
          (byLocalId.status !== "draft" ||
            !isManualAgencyCalculationVersion(byLocalId.calculation_version))
        ) {
          throw new Error(
            `Local invoice ${localId} is not an issuable agency-fee draft.`,
          );
        }
        local = byLocalId;
      }

      // The Stripe account may contain unrelated invoices; those events are
      // valid and can be acknowledged without mutating Dropscale data.
      if (local) {
        const { data: client, error: clientError } = await supabase
          .from("portal_clients")
          .select("stripe_customer_id")
          .eq("id", local.client_id)
          .maybeSingle();
        if (clientError) throw clientError;
        if (!client?.stripe_customer_id) {
          throw new Error(
            `Local invoice ${local.id} has no safely bound Stripe customer.`,
          );
        }

        const manualAgencyInvoice = isManualAgencyCalculationVersion(
          local.calculation_version,
        );
        assertStripeInvoiceMatchesLocal(remote, {
          localInvoiceId: local.id,
          stripeInvoiceId: local.stripe_invoice_id,
          customerId: client.stripe_customer_id,
          currency: local.currency,
          amount: Number(local.amount),
          requireMetadata: manualAgencyInvoice,
          requireManualCollection: manualAgencyInvoice,
          ...(local.calculation_version === CALCULATION_VERSION
            ? { recipient: stripeRecipientExpectation(local.billing_recipient) }
            : {}),
        });

        // Compare-and-set is essential here: the authoritative GET above may
        // have returned `open`, then a different webhook may have stored
        // `paid` before this request reaches the database.
        let updateQuery = supabase
          .from("invoices")
          .update(update)
          .eq("id", local.id)
          .in("status", [
            ...allowedLocalStatusesForStripeUpdate(update.status),
          ]);
        updateQuery = local.stripe_invoice_id
          ? updateQuery.eq("stripe_invoice_id", remote.id)
          : updateQuery.is("stripe_invoice_id", null);
        const { data: updated, error: updateError } = await updateQuery
          .select("id")
          .maybeSingle();
        if (updateError) throw updateError;
        if (!updated) {
          const { data: current, error: currentError } = await supabase
            .from("invoices")
            .select("status, stripe_invoice_id")
            .eq("id", local.id)
            .maybeSingle();
          if (currentError) throw currentError;
          if (!current)
            throw new Error(
              `Invoice ${local.id} disappeared during webhook update.`,
            );
          if (
            current.stripe_invoice_id &&
            current.stripe_invoice_id !== remote.id
          ) {
            throw new Error(
              `Local invoice ${local.id} was linked to a different Stripe invoice.`,
            );
          }
          if (current.status === "waived") {
            throw new Error(
              `Waived invoice ${local.id} cannot be updated from a Stripe invoice.`,
            );
          }

          const decision = stripeInvoiceStatusDecision(
            current.status,
            update.status,
          );
          if (decision === "conflict") {
            throw new Error(
              `Local status ${current.status} conflicts with Stripe status ${update.status}.`,
            );
          }
          if (decision === "apply") {
            throw new Error(
              `Invoice ${local.id} changed concurrently during webhook update.`,
            );
          }
          // A newer local terminal state won the race. The stale event is safe
          // to acknowledge because its remote snapshot must not be written.
        }
      }
    }

    const { data: processed, error: processedError } = await supabase
      .from("stripe_webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: null,
      })
      .eq("id", event.id)
      .select("id")
      .maybeSingle();
    if (processedError) throw processedError;
    if (!processed)
      throw new Error(
        `Stripe event ${event.id} disappeared before completion.`,
      );
  } catch (error) {
    const message = errorMessage(error);
    const { error: recordError } = await supabase
      .from("stripe_webhook_events")
      .update({ processing_error: message })
      .eq("id", event.id)
      .is("processed_at", null);
    if (recordError) {
      console.error(
        "Stripe webhook failed and its error could not be recorded:",
        recordError,
      );
    }
    console.error(`Stripe webhook ${event.id} failed:`, error);
    // Non-2xx is intentional: Stripe will retry the durable, still-unprocessed
    // event, while a later successful delivery marks it complete exactly once.
    return NextResponse.json(
      { error: "Stripe event processing failed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
