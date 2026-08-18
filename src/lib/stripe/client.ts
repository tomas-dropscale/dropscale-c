import "server-only";

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
// Pin the response contract instead of inheriting a mutable account default.
// The webhook endpoint must be configured to this same GA version in Stripe.
const API_VERSION = "2026-02-25.clover";

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly metadata: {
      code?: string;
      type?: string;
      param?: string;
      declineCode?: string;
      requestId?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export type StripeApiKeyMode = "live" | "test";

export function stripeApiKeyMode(
  key = process.env.STRIPE_SECRET_KEY,
): StripeApiKeyMode | null {
  if (key?.startsWith("sk_live_") || key?.startsWith("rk_live_")) return "live";
  if (key?.startsWith("sk_test_") || key?.startsWith("rk_test_")) return "test";
  return null;
}

export function stripeConfigured(): boolean {
  const mode = stripeApiKeyMode();
  return (
    mode !== null && (process.env.NODE_ENV !== "production" || mode === "live")
  );
}

export type StripeReadinessLimitation =
  | "stripe_write_permissions_not_verified"
  | "webhook_signing_secret_match_not_verified";

export type StripeReadiness = {
  keyMode: StripeApiKeyMode | null;
  liveMode: boolean;
  permissions: {
    customersRead: boolean;
    invoicesRead: boolean;
    invoiceItemsRead: boolean;
  };
  limitations: StripeReadinessLimitation[];
};

const STRIPE_READINESS_LIMITATIONS: StripeReadinessLimitation[] = [
  "stripe_write_permissions_not_verified",
  "webhook_signing_secret_match_not_verified",
];

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
          parts.push(
            ...encode(item as Record<string, unknown>, `${name}[${index}]`),
          );
        } else {
          parts.push(
            `${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`,
          );
        }
      });
    } else {
      parts.push(
        `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`,
      );
    }
  }
  return parts;
}

type StripeFetchOptions = {
  method?: "GET" | "POST";
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
};

async function stripeFetch<T>(
  path: string,
  options: StripeFetchOptions = {},
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key)
    throw new StripeError("Stripe isn't configured on this server.", 500);
  const mode = stripeApiKeyMode(key);
  if (!mode)
    throw new StripeError("Stripe API key format is not recognised.", 500);
  if (process.env.NODE_ENV === "production" && mode !== "live") {
    throw new StripeError(
      "Production billing requires a live Stripe API key.",
      500,
    );
  }

  const method = options.method ?? "POST";
  const body = options.params ? encode(options.params).join("&") : undefined;
  const url =
    method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": API_VERSION,
        "Content-Type": "application/x-www-form-urlencoded",
        // Retrying a mutation must never create the same object twice.
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
    });
  } catch {
    const timedOut = controller.signal.aborted;
    throw new StripeError(
      timedOut ? "Stripe request timed out." : "Could not reach Stripe.",
      timedOut ? 504 : 502,
      { code: timedOut ? "request_timeout" : "network_error", retryable: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await res.json().catch(() => null)) as {
    error?: {
      message?: string;
      code?: string;
      type?: string;
      param?: string;
      decline_code?: string;
    };
  } | null;

  if (!res.ok) {
    throw new StripeError(
      payload?.error?.message ?? `Stripe returned ${res.status}.`,
      res.status,
      {
        code: payload?.error?.code,
        type: payload?.error?.type,
        param: payload?.error?.param,
        declineCode: payload?.error?.decline_code,
        requestId: res.headers.get("request-id") ?? undefined,
        retryable:
          res.status === 409 || res.status === 429 || res.status >= 500,
      },
    );
  }
  if (payload === null) {
    throw new StripeError("Stripe returned an invalid response.", 502, {
      code: "invalid_response",
      requestId: res.headers.get("request-id") ?? undefined,
      retryable: true,
    });
  }
  return payload as T;
}

/**
 * Prove live Stripe authentication and the three read permissions billing uses.
 *
 * Every path and method is fixed here rather than accepted from the caller. A
 * future `created` filter guarantees the list responses are empty, so the check
 * neither mutates Stripe nor reads Customer or Invoice data into its result.
 * Write permissions and the remote webhook signing secret cannot be proved by a
 * read-only API call and remain explicit, normalized limitations.
 */
export async function checkStripeReadiness(): Promise<StripeReadiness> {
  const keyMode = stripeApiKeyMode();
  const unavailable = {
    customersRead: false,
    invoicesRead: false,
    invoiceItemsRead: false,
  };

  if (keyMode !== "live") {
    return {
      keyMode,
      liveMode: false,
      permissions: unavailable,
      limitations: [...STRIPE_READINESS_LIMITATIONS],
    };
  }

  // Stripe object creation times come from Stripe's clock. Asking only for
  // objects created tomorrow makes these permission probes deterministically
  // empty without relying on any real Customer or Invoice identifier.
  const futureCreatedAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
  const read = async (path: "/customers" | "/invoices" | "/invoiceitems") => {
    try {
      await stripeFetch(path, {
        method: "GET",
        params: { created: { gt: futureCreatedAt }, limit: 1 },
      });
      return true;
    } catch {
      return false;
    }
  };

  const [customersRead, invoicesRead, invoiceItemsRead] = await Promise.all([
    read("/customers"),
    read("/invoices"),
    read("/invoiceitems"),
  ]);

  return {
    keyMode,
    liveMode: true,
    permissions: { customersRead, invoicesRead, invoiceItemsRead },
    limitations: [...STRIPE_READINESS_LIMITATIONS],
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

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

/** Database-backed fence checked immediately beside every Stripe mutation. */
export type StripeMutationCheckpoint = () => Promise<void>;

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

type StripeCustomer = {
  id: string;
  deleted?: boolean;
  email?: string | null;
  metadata?: Record<string, string>;
};

type StripeSearchResult<T> = {
  data: T[];
  has_more: boolean;
  next_page?: string | null;
};

/** Recover a Customer when Stripe succeeded but the local id write did not. */
export async function findCustomerByMetadata(
  clientId: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(clientId)) {
    throw new StripeError("Invalid Dropscale client id.", 400);
  }

  let pageCursor: string | undefined;
  let match: string | null = null;
  let pages = 0;

  do {
    const page = await stripeFetch<StripeSearchResult<StripeCustomer>>(
      "/customers/search",
      {
        method: "GET",
        params: {
          query: `metadata['dropscale_client_id']:'${clientId}'`,
          limit: 100,
          ...(pageCursor ? { page: pageCursor } : {}),
        },
      },
    );

    for (const customer of page.data) {
      if (customer.metadata?.dropscale_client_id !== clientId) continue;
      if (match && match !== customer.id) {
        throw new StripeError(
          `More than one Stripe customer exists for Dropscale client ${clientId}.`,
          409,
        );
      }
      match = customer.id;
    }

    pages += 1;
    pageCursor = page.has_more ? (page.next_page ?? undefined) : undefined;
    if (page.has_more && !pageCursor) {
      throw new StripeError(
        "Stripe returned an invalid customer-search page.",
        502,
      );
    }
    if (pageCursor && pages >= 10) {
      throw new StripeError(
        "Too many Stripe customers to recover safely.",
        409,
      );
    }
  } while (pageCursor);

  return match;
}

export async function createCustomer(input: {
  email: string;
  name: string;
  clientId: string;
  identity?: BillingIdentity;
  assertLeaseOwnership: StripeMutationCheckpoint;
}): Promise<string> {
  const recoveredId = await findCustomerByMetadata(input.clientId);
  if (recoveredId) {
    // A recovered object may contain identity from an earlier failed attempt.
    // Reuse the same explicit clearing and ownership checks as a normally bound
    // Customer before any invoice can snapshot it.
    await updateCustomerBilling(recoveredId, {
      clientId: input.clientId,
      email: input.email,
      fallbackName: input.name,
      identity: input.identity ?? {},
      assertLeaseOwnership: input.assertLeaseOwnership,
    });
    return recoveredId;
  }

  await input.assertLeaseOwnership();
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
  await input.assertLeaseOwnership();
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
 * Throws on failure. A live invoice must not be finalised with stale customer
 * details after the admin approved a different billing identity.
 */
export async function updateCustomerBilling(
  customerId: string,
  input: {
    clientId: string;
    email: string;
    fallbackName: string;
    identity: BillingIdentity;
    assertLeaseOwnership: StripeMutationCheckpoint;
  },
): Promise<void> {
  const customer = await stripeFetch<StripeCustomer>(
    `/customers/${encodeURIComponent(customerId)}`,
    { method: "GET" },
  );
  if (customer.deleted) {
    throw new StripeError(`Stripe customer ${customerId} was deleted.`, 409);
  }

  const boundClientId = customer.metadata?.dropscale_client_id;
  if (boundClientId && boundClientId !== input.clientId) {
    throw new StripeError(
      `Stripe customer ${customerId} belongs to another client.`,
      409,
    );
  }
  if (
    !boundClientId &&
    customer.email?.trim().toLowerCase() !== input.email.trim().toLowerCase()
  ) {
    throw new StripeError(
      `Legacy Stripe customer ${customerId} cannot be safely linked to this client.`,
      409,
    );
  }

  const address = input.identity.address;
  await input.assertLeaseOwnership();
  await stripeFetch(`/customers/${encodeURIComponent(customerId)}`, {
    params: {
      email: input.email,
      name: input.identity.name ?? input.fallbackName,
      metadata: { dropscale_client_id: input.clientId },
      ...(address
        ? {
            // Explicit blanks clear stale legal details when the billing
            // profile was intentionally emptied after a previous invoice.
            address: {
              line1: address.line1 ?? "",
              line2: address.line2 ?? "",
              city: address.city ?? "",
              postal_code: address.postal_code ?? "",
              state: address.state ?? "",
              country: address.country ?? "",
            },
          }
        : { address: "" }),
    },
  });
  await input.assertLeaseOwnership();
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type StripeInvoice = {
  id: string;
  status: string;
  hosted_invoice_url: string | null;
  due_date: number | null;
  collection_method?: string;
  auto_advance?: boolean;
  customer?: string | { id: string } | null;
  currency?: string | null;
  total?: number;
  amount_due?: number | null;
  amount_remaining?: number | null;
  number?: string | null;
  invoice_pdf?: string | null;
  metadata?: Record<string, string>;
  /** Immutable customer fields copied onto a finalised Stripe invoice. */
  customer_email?: string | null;
  customer_name?: string | null;
  customer_address?: StripeInvoiceAddress | null;
  custom_fields?: { name: string; value: string }[] | null;
  status_transitions?: {
    finalized_at?: number | null;
    paid_at?: number | null;
    voided_at?: number | null;
    marked_uncollectible_at?: number | null;
  };
};

export type StripeInvoiceAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  state?: string | null;
  country?: string | null;
};

/** Exact recipient values that must be frozen on the Stripe Invoice object. */
export type StripeInvoiceRecipientExpectation = {
  email: string;
  name: string;
  address: Required<StripeInvoiceAddress>;
  taxId: string | null;
};

export type StripeLocalInvoiceStatus =
  "draft" | "open" | "paid" | "void" | "uncollectible";

export type StripeInvoiceStatusDecision = "apply" | "ignore_stale" | "conflict";

/**
 * Stripe invoice states form a graph, not a freely editable enum:
 *
 *   draft -> open -> paid | void | uncollectible -> paid
 *
 * A GET can race a webhook (or another reconcile), so the database update has
 * to compare its status at write time. These are the only local states from
 * which an observed remote state may be applied.
 */
const STRIPE_STATUS_PREDECESSORS: Record<
  StripeLocalInvoiceStatus,
  readonly StripeLocalInvoiceStatus[]
> = {
  draft: ["draft"],
  open: ["draft", "open"],
  paid: ["draft", "open", "uncollectible", "paid"],
  void: ["draft", "open", "void"],
  uncollectible: ["draft", "open", "uncollectible"],
};

export function allowedLocalStatusesForStripeUpdate(
  incoming: StripeLocalInvoiceStatus,
): readonly StripeLocalInvoiceStatus[] {
  return STRIPE_STATUS_PREDECESSORS[incoming];
}

/**
 * Decide what to do after an optimistic conditional update matched no row.
 * `ignore_stale` is a valid older Stripe snapshot; `conflict` is a pair of
 * mutually exclusive terminal states and must remain visible to operations.
 */
export function stripeInvoiceStatusDecision(
  current: StripeLocalInvoiceStatus,
  incoming: StripeLocalInvoiceStatus,
): StripeInvoiceStatusDecision {
  if (STRIPE_STATUS_PREDECESSORS[incoming].includes(current)) return "apply";

  const knownOlderSnapshots: Partial<
    Record<StripeLocalInvoiceStatus, readonly StripeLocalInvoiceStatus[]>
  > = {
    open: ["draft"],
    uncollectible: ["draft", "open"],
    paid: ["draft", "open", "uncollectible"],
    void: ["draft", "open"],
  };
  return knownOlderSnapshots[current]?.includes(incoming)
    ? "ignore_stale"
    : "conflict";
}

export type StripeAuthoritativeInvoiceUpdate = {
  status: StripeLocalInvoiceStatus;
  stripe_invoice_id: string;
  stripe_hosted_url: string | null;
  stripe_invoice_number: string | null;
  stripe_invoice_pdf: string | null;
  amount_remaining?: number;
  due_date?: string | null;
  issued_at?: string;
  paid_at?: string;
  payment_failed_at?: string | null;
  issue_error?: null;
  stripe_sent_at?: string;
  stripe_delivery_assumed_at?: null;
  updated_at: string;
};

export type LocalStripeInvoiceExpectation = {
  localInvoiceId: string;
  stripeInvoiceId?: string | null;
  customerId: string;
  currency: string;
  /** Approved amount in the currency's major unit (euros for v1 billing). */
  amount: number;
  /** New manual invoices must carry our immutable local id in Stripe metadata. */
  requireMetadata: boolean;
  /** Legacy rows may predate the manual send-invoice contract. */
  requireManualCollection?: boolean;
  /** Required for v3: validate Stripe's own immutable finalised snapshot. */
  recipient?: StripeInvoiceRecipientExpectation;
};

function isoFromSeconds(
  seconds: number | null | undefined,
): string | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

function isoDayFromSeconds(
  seconds: number | null | undefined,
): string | null | undefined {
  const instant = isoFromSeconds(seconds);
  return instant?.slice(0, 10) ?? (seconds === null ? null : undefined);
}

export function localInvoiceStatus(
  status: string,
): StripeLocalInvoiceStatus | null {
  switch (status) {
    case "draft":
    case "open":
    case "paid":
    case "void":
    case "uncollectible":
      return status;
    default:
      return null;
  }
}

function assertStripeVatIdentity(
  invoice: StripeInvoice,
  expected: StripeInvoiceRecipientExpectation,
): void {
  const fields = invoice.custom_fields ?? [];
  const expectedFields = expected.taxId
    ? [{ name: "VAT / Tax ID", value: expected.taxId }]
    : [];
  if (
    fields.length !== expectedFields.length ||
    fields.some(
      (field, index) =>
        field.name !== expectedFields[index]?.name ||
        field.value !== expectedFields[index]?.value,
    )
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has a different VAT / Tax ID snapshot.`,
      409,
    );
  }
}

/** Assert the immutable recipient copied onto Stripe when an invoice finalises. */
export function assertStripeInvoiceRecipientMatches(
  invoice: StripeInvoice,
  expected: StripeInvoiceRecipientExpectation,
  options: { allowUnfinalizedDraft?: boolean } = {},
): void {
  assertStripeVatIdentity(invoice, expected);
  if (options.allowUnfinalizedDraft && invoice.status === "draft") return;

  if (
    invoice.customer_email !== expected.email ||
    invoice.customer_name !== expected.name
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has a different customer name or email snapshot.`,
      409,
    );
  }

  // Stripe stores a cleared address field as "" while our snapshot stores
  // null; the two are the same commercial fact. Legacy customers created by
  // the pre-platform integration carry all-empty-string addresses, and the
  // strict comparison finalised their invoices on Stripe and then refused to
  // record the receipt locally — every weekly issue for those clients wedged
  // as draft+error while Stripe already showed the invoice as open.
  const blankToNull = (value: string | null | undefined): string | null => {
    const trimmed = typeof value === "string" ? value.trim() : value ?? null;
    return trimmed ? trimmed : null;
  };

  const expectedAddress = expected.address;
  const expectedHasAddress = Object.values(expectedAddress).some(
    (value) => blankToNull(value) !== null,
  );
  const remoteAddress = invoice.customer_address;
  if (!remoteAddress) {
    if (expectedHasAddress) {
      throw new StripeError(
        `Stripe invoice ${invoice.id} has no approved customer address snapshot.`,
        409,
      );
    }
    return;
  }

  for (const key of [
    "line1",
    "line2",
    "city",
    "postal_code",
    "state",
    "country",
  ] as const) {
    if (blankToNull(remoteAddress[key]) !== blankToNull(expectedAddress[key])) {
      throw new StripeError(
        `Stripe invoice ${invoice.id} has a different customer address snapshot.`,
        409,
      );
    }
  }
}

/**
 * Fail closed before a webhook/reconcile can attach remote state to a local
 * commercial record. Legacy invoices may omit our metadata, but only when the
 * already-persisted Stripe id, Customer, currency and total all match.
 */
export function assertStripeInvoiceMatchesLocal(
  invoice: StripeInvoice,
  expected: LocalStripeInvoiceExpectation,
): void {
  if (expected.stripeInvoiceId && invoice.id !== expected.stripeInvoiceId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} does not match local invoice ${expected.localInvoiceId}.`,
      409,
    );
  }
  if (objectId(invoice.customer) !== expected.customerId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} belongs to another customer.`,
      409,
    );
  }

  const expectedCurrency = expected.currency.trim().toLowerCase();
  if (
    !expectedCurrency ||
    invoice.currency?.toLowerCase() !== expectedCurrency
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} currency does not match the local invoice.`,
      409,
    );
  }

  const expectedCents = Math.round(expected.amount * 100);
  if (
    !Number.isFinite(expected.amount) ||
    expected.amount <= 0 ||
    !Number.isSafeInteger(expectedCents) ||
    Math.abs(expected.amount * 100 - expectedCents) > 1e-6 ||
    invoice.total !== expectedCents
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} total does not match the approved local amount.`,
      409,
    );
  }

  const remoteLocalId = invoice.metadata?.dropscale_invoice_id;
  if (
    (remoteLocalId && remoteLocalId !== expected.localInvoiceId) ||
    (expected.requireMetadata && remoteLocalId !== expected.localInvoiceId) ||
    (!remoteLocalId && !expected.stripeInvoiceId)
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has different Dropscale metadata.`,
      409,
    );
  }

  if (
    expected.requireManualCollection &&
    (invoice.collection_method !== "send_invoice" ||
      invoice.auto_advance !== false)
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} is not a manual-payment invoice.`,
      409,
    );
  }
  if (expected.recipient) {
    assertStripeInvoiceRecipientMatches(invoice, expected.recipient, {
      allowUnfinalizedDraft: true,
    });
  }
}

/** Convert a freshly retrieved Stripe Invoice into a monotonic local update. */
export function authoritativeInvoiceUpdate(
  invoice: StripeInvoice,
  eventType: string,
  eventCreated: number,
  now = new Date(),
): StripeAuthoritativeInvoiceUpdate {
  const status = localInvoiceStatus(invoice.status);
  if (!status)
    throw new Error(`Unsupported Stripe invoice status: ${invoice.status}`);

  const issuedAt = isoFromSeconds(invoice.status_transitions?.finalized_at);
  const paidAt = isoFromSeconds(invoice.status_transitions?.paid_at);
  const dueDate = isoDayFromSeconds(invoice.due_date);

  return {
    status,
    stripe_invoice_id: invoice.id,
    stripe_hosted_url: invoice.hosted_invoice_url,
    stripe_invoice_number: invoice.number ?? null,
    stripe_invoice_pdf: invoice.invoice_pdf ?? null,
    ...(typeof invoice.amount_remaining === "number"
      ? { amount_remaining: invoice.amount_remaining / 100 }
      : {}),
    ...(dueDate !== undefined ? { due_date: dueDate } : {}),
    ...(issuedAt ? { issued_at: issuedAt } : {}),
    ...(paidAt ? { paid_at: paidAt } : {}),
    ...(eventType === "invoice.sent"
      ? {
          stripe_sent_at: isoFromSeconds(eventCreated) ?? now.toISOString(),
          stripe_delivery_assumed_at: null,
          issue_error: null,
        }
      : {}),
    ...(["paid", "void", "uncollectible"].includes(status)
      ? { payment_failed_at: null }
      : eventType === "invoice.payment_failed"
        ? {
            payment_failed_at:
              isoFromSeconds(eventCreated) ?? now.toISOString(),
          }
        : {}),
    updated_at: now.toISOString(),
  };
}

type StripeInvoiceItem = {
  id: string;
  amount: number;
  currency: string;
  customer: string | { id: string };
  description: string | null;
  invoice: string | { id: string } | null;
  metadata: Record<string, string>;
};

type StripeList<T> = {
  data: T[];
  has_more: boolean;
};

function objectId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function asEurosInCents(amount: number, label: string): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new StripeError(
      `Invoice line "${label}" must have a positive amount.`,
      400,
    );
  }

  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-6) {
    throw new StripeError(
      `Invoice line "${label}" must be rounded to euro cents.`,
      400,
    );
  }
  return cents;
}

async function listInvoiceItems(
  invoiceId: string,
): Promise<StripeInvoiceItem[]> {
  const items: StripeInvoiceItem[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await stripeFetch<StripeList<StripeInvoiceItem>>(
      "/invoiceitems",
      {
        method: "GET",
        params: {
          invoice: invoiceId,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
      },
    );
    items.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) {
      throw new StripeError(
        "Stripe returned an invalid invoice-item page.",
        502,
      );
    }
  } while (startingAfter);

  return items;
}

/**
 * Recover an invoice created in the narrow window before its id was stored
 * locally. It may be draft, open, or even paid if a later database write was
 * the step that failed. Metadata remains stable beyond Stripe's 24-hour
 * idempotency-key retention window.
 */
export async function findInvoiceByMetadata(
  customerId: string,
  localInvoiceId: string,
): Promise<StripeInvoice | null> {
  let startingAfter: string | undefined;
  let pages = 0;
  let match: StripeInvoice | null = null;

  do {
    const page = await stripeFetch<StripeList<StripeInvoice>>("/invoices", {
      method: "GET",
      params: {
        customer: customerId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
    });

    for (const invoice of page.data) {
      if (invoice.metadata?.dropscale_invoice_id !== localInvoiceId) continue;
      if (match && match.id !== invoice.id) {
        throw new StripeError(
          `More than one Stripe invoice exists for local invoice ${localInvoiceId}.`,
          409,
        );
      }
      match = invoice;
    }

    pages += 1;
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) {
      throw new StripeError("Stripe returned an invalid invoice page.", 502);
    }
    // Stop instead of making an unbounded request chain and risking a duplicate
    // we did not see beyond this deliberately conservative ceiling.
    if (startingAfter && pages >= 10) {
      throw new StripeError("Too many Stripe invoices to recover safely.", 409);
    }
  } while (startingAfter);

  return match;
}

function assertInvoiceMatches(
  invoice: StripeInvoice,
  items: StripeInvoiceItem[],
  expected: {
    customerId: string;
    invoiceId: string;
    lines: { label: string; amount: number }[];
    recipient: StripeInvoiceRecipientExpectation;
  },
): void {
  const customerId = objectId(invoice.customer);
  if (customerId !== expected.customerId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} belongs to another customer.`,
      409,
    );
  }
  if (invoice.currency?.toLowerCase() !== "eur") {
    throw new StripeError(
      `Stripe invoice ${invoice.id} is not denominated in EUR.`,
      409,
    );
  }
  if (
    invoice.collection_method !== "send_invoice" ||
    invoice.auto_advance !== false
  ) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} is not a manual-payment invoice.`,
      409,
    );
  }
  if (invoice.metadata?.dropscale_invoice_id !== expected.invoiceId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has different Dropscale metadata.`,
      409,
    );
  }
  assertStripeInvoiceRecipientMatches(invoice, expected.recipient, {
    allowUnfinalizedDraft: true,
  });
  if (items.length !== expected.lines.length) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has ${items.length} lines; expected ${expected.lines.length}.`,
      409,
    );
  }

  let expectedTotal = 0;
  const byIndex = new Map<number, StripeInvoiceItem>();
  for (const item of items) {
    const localId = item.metadata?.dropscale_invoice_id;
    const index = Number(item.metadata?.dropscale_line_index);
    if (
      localId !== expected.invoiceId ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected.lines.length ||
      byIndex.has(index)
    ) {
      throw new StripeError(
        `Stripe invoice ${invoice.id} contains an unexpected line.`,
        409,
      );
    }
    byIndex.set(index, item);
  }

  for (const [index, line] of expected.lines.entries()) {
    const expectedAmount = asEurosInCents(line.amount, line.label);
    expectedTotal += expectedAmount;
    const item = byIndex.get(index);
    if (
      !item ||
      item.amount !== expectedAmount ||
      item.currency.toLowerCase() !== "eur" ||
      item.description !== line.label ||
      objectId(item.customer) !== expected.customerId ||
      objectId(item.invoice) !== invoice.id
    ) {
      throw new StripeError(
        `Stripe invoice ${invoice.id} line ${index + 1} does not match.`,
        409,
      );
    }
  }

  if (invoice.total !== expectedTotal || invoice.amount_due !== expectedTotal) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} totals do not match the approved EUR amount.`,
      409,
    );
  }
}

/**
 * Materialise an approved invoice as a Stripe draft, verify it, then explicitly
 * finalise and send it. This function never auto-charges a payment method.
 */
export async function createAndFinalizeInvoice(input: {
  customerId: string;
  currency: string;
  lines: { label: string; amount: number }[];
  daysUntilDue: number;
  description: string;
  /** Ours, for idempotency and for the webhook to find the row again. */
  invoiceId: string;
  /** Retained in the call shape to make an accidental `true` fail loudly. */
  autoCharge?: false;
  /** Resume a draft whose Stripe id has already been persisted locally. */
  existingStripeInvoiceId?: string;
  /** Persist a new/recovered draft id before a single line is added. */
  onDraftCreated?: (stripeInvoiceId: string) => Promise<void>;
  /** Recipient snapshot already persisted in the local invoice. */
  recipient: StripeInvoiceRecipientExpectation;
  /** Renew and fence-check the per-client lease beside every Stripe POST. */
  assertLeaseOwnership: StripeMutationCheckpoint;
  /** Persist delivery evidence immediately after Stripe accepts /send. */
  onSent?: (stripeInvoice: StripeInvoice) => Promise<void>;
}): Promise<StripeInvoice> {
  if (input.currency.toUpperCase() !== "EUR") {
    throw new StripeError(
      "Manual agency invoices must be denominated in EUR.",
      400,
    );
  }
  if ((input as { autoCharge?: boolean }).autoCharge === true) {
    throw new StripeError(
      "Automatic charging is disabled for agency invoices.",
      400,
    );
  }
  if (!input.customerId || !input.invoiceId || input.lines.length === 0) {
    throw new StripeError(
      "Customer, local invoice id and at least one line are required.",
      400,
    );
  }
  if (!Number.isInteger(input.daysUntilDue) || input.daysUntilDue < 1) {
    throw new StripeError("daysUntilDue must be a positive whole number.", 400);
  }
  // Validate every amount before any remote object is created.
  input.lines.forEach((line) => asEurosInCents(line.amount, line.label));

  let invoice = input.existingStripeInvoiceId
    ? await getInvoice(input.existingStripeInvoiceId)
    : await findInvoiceByMetadata(input.customerId, input.invoiceId);

  const needsLocalPersistence = !input.existingStripeInvoiceId;
  if (!invoice) {
    await input.assertLeaseOwnership();
    invoice = await stripeFetch<StripeInvoice>("/invoices", {
      params: {
        customer: input.customerId,
        currency: "eur",
        collection_method: "send_invoice",
        days_until_due: input.daysUntilDue,
        description: input.description,
        // Nothing leaves draft state without this function's validation.
        auto_advance: false,
        automatic_tax: { enabled: false },
        // Do not pull unrelated pending items or customer-level discounts into
        // the exact amount the admin approved.
        pending_invoice_items_behavior: "exclude",
        discounts: "",
        metadata: { dropscale_invoice_id: input.invoiceId },
        ...(input.recipient.taxId
          ? {
              custom_fields: [
                { name: "VAT / Tax ID", value: input.recipient.taxId },
              ],
            }
          : {}),
      },
      idempotencyKey: `invoice:${input.invoiceId}`,
    });
    await input.assertLeaseOwnership();
  }

  if (needsLocalPersistence && input.onDraftCreated) {
    // Deliberately awaited before invoice items: if the database write fails,
    // the Stripe object remains an inert, recoverable draft.
    await input.onDraftCreated(invoice.id);
  }

  // An idempotent create replay can return the response cached for the first
  // request even when that object has since been finalised. Always branch on a
  // fresh authoritative state.
  invoice = await getInvoice(invoice.id);

  if (objectId(invoice.customer) !== input.customerId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} belongs to another customer.`,
      409,
    );
  }
  if (invoice.metadata?.dropscale_invoice_id !== input.invoiceId) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has different Dropscale metadata.`,
      409,
    );
  }
  if (!["draft", "open", "paid"].includes(invoice.status)) {
    throw new StripeError(
      `Stripe invoice ${invoice.id} cannot be resumed from status ${invoice.status}.`,
      409,
    );
  }

  let items = await listInvoiceItems(invoice.id);
  if (invoice.status === "draft") {
    const existingByIndex = new Map<number, StripeInvoiceItem>();
    for (const item of items) {
      const localId = item.metadata?.dropscale_invoice_id;
      const index = Number(item.metadata?.dropscale_line_index);
      if (
        localId !== input.invoiceId ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= input.lines.length ||
        existingByIndex.has(index)
      ) {
        throw new StripeError(
          `Stripe draft ${invoice.id} contains an unexpected line.`,
          409,
        );
      }
      existingByIndex.set(index, item);
    }

    for (const [index, line] of input.lines.entries()) {
      const expectedAmount = asEurosInCents(line.amount, line.label);
      const existing = existingByIndex.get(index);
      if (existing) {
        if (
          existing.amount !== expectedAmount ||
          existing.currency.toLowerCase() !== "eur" ||
          existing.description !== line.label
        ) {
          throw new StripeError(
            `Stripe draft ${invoice.id} line ${index + 1} changed.`,
            409,
          );
        }
        continue;
      }

      await input.assertLeaseOwnership();
      await stripeFetch("/invoiceitems", {
        params: {
          customer: input.customerId,
          invoice: invoice.id,
          currency: "eur",
          amount: expectedAmount,
          description: line.label,
          metadata: {
            dropscale_invoice_id: input.invoiceId,
            dropscale_line_index: String(index),
          },
        },
        idempotencyKey: `invoiceitem:${input.invoiceId}:${index}`,
      });
      await input.assertLeaseOwnership();
    }

    // Retrieve rather than trusting the create responses: validation happens
    // against Stripe's authoritative draft immediately before finalisation.
    [invoice, items] = await Promise.all([
      getInvoice(invoice.id),
      listInvoiceItems(invoice.id),
    ]);
    assertInvoiceMatches(invoice, items, input);

    await input.assertLeaseOwnership();
    invoice = await stripeFetch<StripeInvoice>(
      `/invoices/${invoice.id}/finalize`,
      {
        params: { auto_advance: false },
        idempotencyKey: `finalize:${input.invoiceId}`,
      },
    );
    await input.assertLeaseOwnership();
    // Finalisation is the irreversible boundary. Re-read both the invoice and
    // its lines so a concurrent Dashboard/API edit cannot hide behind the
    // pre-finalisation item list before we explicitly send it.
    [invoice, items] = await Promise.all([
      getInvoice(invoice.id),
      listInvoiceItems(invoice.id),
    ]);
    assertInvoiceMatches(invoice, items, input);
  } else {
    assertInvoiceMatches(invoice, items, input);
  }

  if (invoice.status === "open") {
    // Sending is explicit because Stripe account-level email automation may be
    // disabled. A stable key makes immediate retries safe.
    await input.assertLeaseOwnership();
    invoice = await stripeFetch<StripeInvoice>(`/invoices/${invoice.id}/send`, {
      idempotencyKey: `send:${input.invoiceId}`,
    });
    assertInvoiceMatches(invoice, items, input);
    // A successful /send response is monotonic delivery evidence. Persist it
    // before the post-mutation lease check: losing the lease after Stripe has
    // accepted delivery must not leave this invoice eligible for a later send.
    await input.onSent?.(invoice);
    await input.assertLeaseOwnership();
  }

  if (!invoice.hosted_invoice_url && invoice.status !== "paid") {
    throw new StripeError(
      `Stripe invoice ${invoice.id} has no hosted payment URL.`,
      502,
    );
  }
  return invoice;
}

export async function getInvoice(
  stripeInvoiceId: string,
): Promise<StripeInvoice> {
  return stripeFetch<StripeInvoice>(
    `/invoices/${encodeURIComponent(stripeInvoiceId)}`,
    {
      method: "GET",
    },
  );
}

/**
 * Void one Stripe invoice, converging on retries: a second void of the same
 * invoice reports the already-void state as success instead of failing the
 * arrears absorption it belongs to. Any other failure (already paid, deleted)
 * propagates so the caller fails closed.
 */
export async function voidStripeInvoice(
  stripeInvoiceId: string,
): Promise<StripeInvoice> {
  try {
    return await stripeFetch<StripeInvoice>(
      `/invoices/${encodeURIComponent(stripeInvoiceId)}/void`,
      { idempotencyKey: `void:${stripeInvoiceId}` },
    );
  } catch (error) {
    const current = await getInvoice(stripeInvoiceId).catch(() => null);
    if (current?.status === "void") return current;
    throw error;
  }
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
export function parseStripeSignatureHeader(
  header: string | null,
): { timestamp: string; signatures: string[] } | null {
  if (!header) return null;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const segment of header.split(",")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp ??= value;
    if (key === "v1" && /^[0-9a-f]+$/i.test(value))
      signatures.push(value.toLowerCase());
  }

  return timestamp && signatures.length > 0 ? { timestamp, signatures } : null;
}

function constantTimeHexEqual(expected: string, candidate: string): boolean {
  let diff = expected.length ^ candidate.length;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ (candidate.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export async function verifyWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return false;
  const { timestamp, signatures } = parsed;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || toleranceSeconds < 0 || age > toleranceSeconds)
    return false;

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

  // Secret rotation produces multiple v1 values in the same header. Compare
  // every candidate and do not let a later valid signature be overwritten.
  let match = false;
  for (const signature of signatures) {
    match = constantTimeHexEqual(expected, signature) || match;
  }
  return match;
}
