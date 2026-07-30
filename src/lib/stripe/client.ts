/**
 * Stripe, over its REST API with plain `fetch`.
 *
 * Same choice as the Google Ads and Shopify integrations in this codebase: no
 * SDK. Stripe's Node library carries a runtime shim that fights Workers, and
 * everything billing needs here is four endpoints and form-encoded bodies.
 *
 * Nothing in this file talks to the database, and no secret ever leaves it —
 * the key is read from the environment per call, never cached in a module.
 */

const API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Stripe speaks form encoding, including for nested params (`a[b][c]`). */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(...encode(value as Record<string, unknown>, name));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          parts.push(...encode(item as Record<string, unknown>, `${name}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

async function stripeFetch<T>(
  path: string,
  options: { method?: "GET" | "POST"; params?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe isn't configured on this server.", 500);

  const method = options.method ?? "POST";
  const body = options.params ? encode(options.params).join("&") : undefined;
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Retrying a create must never bill twice — the caller passes a key
      // derived from the invoice it is materialising.
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
  });

  const payload = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;

  if (!res.ok) {
    throw new StripeError(
      payload?.error?.message ?? `Stripe returned ${res.status}.`,
      res.status,
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Whether this customer has a card we may charge without asking.
 *
 * The existence of a Stripe customer proves nothing — one is created the first
 * time we invoice. Only a default payment method means "automatic".
 */
export async function customerHasCard(customerId: string): Promise<boolean> {
  try {
    const customer = await stripeFetch<{
      invoice_settings?: { default_payment_method?: string | null };
      default_source?: string | null;
    }>(`/customers/${customerId}`, { method: "GET" });
    return Boolean(customer.invoice_settings?.default_payment_method ?? customer.default_source);
  } catch {
    return false;
  }
}

/**
 * Adopt the card a customer just paid with, so the NEXT invoice settles itself.
 *
 * This is what makes automatic payment possible without ever asking a client to
 * enter a card in our app. They pay their first invoice on Stripe's own hosted
 * page and tick "save my details"; Stripe attaches the card to the customer but
 * does NOT make it the default for future invoices — that part is ours.
 *
 * Does nothing when a default is already set (we must never silently switch a
 * client's card) or when nothing was saved (the checkbox is theirs to refuse).
 * Returns whether a default was adopted.
 *
 * Requires Stripe → Settings → Invoices → "Save customer payment information"
 * to be enabled; with it off, no card is ever saved and nothing here can fire.
 */
export async function adoptDefaultPaymentMethod(customerId: string): Promise<boolean> {
  try {
    const customer = await stripeFetch<{
      invoice_settings?: { default_payment_method?: string | null };
    }>(`/customers/${customerId}`, { method: "GET" });

    if (customer.invoice_settings?.default_payment_method) return false;

    const methods = await stripeFetch<{ data?: { id: string }[] }>("/payment_methods", {
      method: "GET",
      params: { customer: customerId, type: "card", limit: 1 },
    });

    const card = methods.data?.[0]?.id;
    if (!card) return false;

    await setDefaultPaymentMethod(customerId, card);
    return true;
  } catch (error) {
    // Never fail the webhook over this: the invoice IS paid, and the worst case
    // is that the next one goes out as a link again.
    console.error(`Could not adopt a default card for ${customerId}:`, error);
    return false;
  }
}

/**
 * The invoice identity a client entered in their settings (migration 0020).
 * Every field optional: an invoice still goes out without them, it just carries
 * the portal name and no address.
 */
export type BillingIdentity = {
  name?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    postal_code?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
};

/** Drops empty fields so a blank profile never overwrites good data with "". */
function identityParams(identity?: BillingIdentity): Record<string, unknown> {
  if (!identity) return {};

  const address = Object.fromEntries(
    Object.entries(identity.address ?? {}).filter(([, value]) => value),
  );

  return {
    ...(identity.name ? { name: identity.name } : {}),
    ...(Object.keys(address).length > 0 ? { address } : {}),
  };
}

export async function createCustomer(input: {
  email: string;
  name: string;
  clientId: string;
  identity?: BillingIdentity;
}): Promise<string> {
  const customer = await stripeFetch<{ id: string }>("/customers", {
    params: {
      email: input.email,
      name: input.name,
      // Lets anyone in the Stripe dashboard trace a customer back to a portal
      // account without guessing from the email.
      metadata: { dropscale_client_id: input.clientId },
      // The billing profile wins over the login name when it is filled in.
      ...identityParams(input.identity),
    },
    idempotencyKey: `customer:${input.clientId}`,
  });
  return customer.id;
}

/**
 * Push the client's invoice identity onto an EXISTING Stripe customer.
 *
 * Called right before each invoice is raised rather than only when the profile
 * is saved. Customers created before any of this existed carry only a login
 * name, and an address entered today has to reach the invoice raised on Monday
 * — re-asserting it at issue time is what guarantees that, whatever order
 * things happened in.
 *
 * Never throws: a billing detail that fails to sync must not stop the invoice.
 */
export async function updateCustomerBilling(
  customerId: string,
  identity: BillingIdentity,
): Promise<void> {
  const params = identityParams(identity);
  if (Object.keys(params).length === 0) return;

  try {
    await stripeFetch(`/customers/${customerId}`, { params });
  } catch (error) {
    console.error(`Could not sync billing details to ${customerId}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type StripeInvoice = {
  id: string;
  status: string;
  hosted_invoice_url: string | null;
  due_date: number | null;
};

/**
 * Build and finalise an invoice: one invoice item per line, then the invoice.
 *
 * `collection_method` is send_invoice — the client gets a payable link. Stripe
 * charges a saved card automatically instead when one is on file, which is
 * what "pay automatically" means here: the client sets a card up once and
 * every Monday settles itself.
 */
export async function createAndFinalizeInvoice(input: {
  customerId: string;
  currency: string;
  lines: { label: string; amount: number }[];
  daysUntilDue: number;
  description: string;
  /** Ours, for idempotency and for the webhook to find the row again. */
  invoiceId: string;
  autoCharge: boolean;
  /**
   * VAT / company number to print on the invoice. Sent as a custom field rather
   * than a Stripe tax id: those require a jurisdiction-specific type we cannot
   * infer from a bare string, and guessing it wrong makes the invoice fail to
   * finalise. A printed line satisfies what the client needs it for.
   */
  taxId?: string | null;
}): Promise<StripeInvoice> {
  const invoice = await stripeFetch<StripeInvoice>("/invoices", {
    params: {
      customer: input.customerId,
      currency: input.currency.toLowerCase(),
      collection_method: input.autoCharge ? "charge_automatically" : "send_invoice",
      ...(input.autoCharge ? {} : { days_until_due: input.daysUntilDue }),
      description: input.description,
      auto_advance: true,
      metadata: { dropscale_invoice_id: input.invoiceId },
      ...(input.taxId
        ? { custom_fields: [{ name: "VAT / Tax ID", value: input.taxId.slice(0, 30) }] }
        : {}),
    },
    idempotencyKey: `invoice:${input.invoiceId}`,
  });

  // Items must name the invoice explicitly; otherwise Stripe parks them on the
  // customer's next draft and this invoice finalises at zero.
  for (const [index, line] of input.lines.entries()) {
    await stripeFetch("/invoiceitems", {
      params: {
        customer: input.customerId,
        invoice: invoice.id,
        currency: input.currency.toLowerCase(),
        amount: Math.round(line.amount * 100),
        description: line.label,
      },
      idempotencyKey: `invoiceitem:${input.invoiceId}:${index}`,
    });
  }

  return stripeFetch<StripeInvoice>(`/invoices/${invoice.id}/finalize`, {
    idempotencyKey: `finalize:${input.invoiceId}`,
  });
}

export async function getInvoice(stripeInvoiceId: string): Promise<StripeInvoice> {
  return stripeFetch<StripeInvoice>(`/invoices/${stripeInvoiceId}`, { method: "GET" });
}

/**
 * A Checkout session in `setup` mode: the client saves a card once, and every
 * later invoice charges it without anyone clicking anything.
 */
export async function createSetupSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  // Distinct return URLs, because Stripe tells us nothing else: with one URL
  // for both, a client who cancelled and a client who saved a card come back to
  // an identical page and neither learns what happened.
  const session = await stripeFetch<{ url: string }>("/checkout/sessions", {
    params: {
      mode: "setup",
      customer: input.customerId,
      success_url: `${input.returnUrl}?setup=done`,
      cancel_url: `${input.returnUrl}?setup=cancelled`,
      // Makes the saved card the default for future invoices.
      "setup_intent_data[metadata][dropscale]": "default_payment_method",
    },
  });
  return session;
}

/** Point the customer's future invoices at the card they just saved. */
export async function setDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<void> {
  await stripeFetch(`/customers/${customerId}`, {
    params: { invoice_settings: { default_payment_method: paymentMethodId } },
  });
}

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * Written against Web Crypto rather than the SDK so it runs on Workers. The
 * timestamp check is what stops a captured-and-replayed webhook from marking
 * invoices paid forever.
 */
export async function verifyWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((part) => part.split("=", 2) as [string, string]),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare: a length-varying early return leaks the prefix.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}
