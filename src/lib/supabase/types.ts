/**
 * Database types for the WHOLE platform — admin tables (profiles, board,
 * finance) and client-portal tables (portal_clients, ad_accounts, …) live in
 * the same Supabase project, so they live in the same Database type.
 *
 * Two "client" concepts, two names, on purpose:
 *   CrmClient (table `clients`)        — CRM record; may never have a login.
 *   Client    (table `portal_clients`) — portal LOGIN identity (auth.users id).
 *
 * The Relationships metadata is not decorative: supabase-js infers embed
 * types from it (`select("*, card_assignees(user_id)")`). Without these
 * entries the embed resolves to `SelectQueryError`. Constraint names follow
 * the Postgres default: <table>_<column>_fkey.
 */

// ---------------------------------------------------------------------------
// Team / board
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Priority = "low" | "medium" | "high" | "urgent";
export type Role = "admin" | "member";

export type Profile = {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  role: Role;
  created_at: string;
};

export type Board = {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
};

export type BoardColumn = {
  id: string;
  board_id: string;
  name: string;
  position: number;
};

export type Card = {
  id: string;
  column_id: string;
  title: string;
  description: string | null;
  priority: Priority;
  labels: string[];
  due_date: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CardAssignee = {
  card_id: string;
  user_id: string;
};

export type CardComment = {
  id: string;
  card_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
};

/** Card hydrated with its assignees' profiles, as the board consumes it. */
export type CardWithAssignees = Card & {
  assignees: Profile[];
};

export type ColumnWithCards = BoardColumn & {
  cards: CardWithAssignees[];
};

export type CommentWithAuthor = CardComment & {
  author: Profile | null;
};

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export type ClientStatus = "lead" | "active" | "paused" | "churned";
export type SourceCategory =
  "platform" | "supplier" | "incorporation" | "saas" | "other";
export type CommissionStatus = "pending" | "confirmed" | "paid";
export type ExpenseCategory =
  "ads" | "tools" | "salaries" | "contractors" | "office" | "taxes" | "other";

export type CrmClient = {
  id: string;
  name: string;
  email: string | null;
  status: ClientStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type RevenueSource = {
  id: string;
  name: string;
  category: SourceCategory;
  default_rate: number;
  recurring: boolean;
  active: boolean;
  notes: string | null;
  created_at: string;
};

export type Commission = {
  id: string;
  source_id: string;
  client_id: string | null;
  occurred_on: string;
  gross_amount: number | string;
  rate: number;
  amount: number | string;
  currency: string;
  status: CommissionStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Set on rows auto-synced from Google Ads (migration 0007); null = manual. */
  ad_account_id: string | null;
};

export type Expense = {
  id: string;
  category: ExpenseCategory;
  vendor: string | null;
  description: string | null;
  incurred_on: string;
  amount: number;
  currency: string;
  recurring: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Client portal
// ---------------------------------------------------------------------------

export type AdAccountStatus = "active" | "suspended" | "pending";
export type AdAccountReportingRole =
  "legacy_hybrid" | "shopify_anchor" | "google_spend";
export type RequestType = "google_ads" | "shopify";
export type RequestStatus = "pending" | "approved" | "rejected";
export type CampaignStatus = "active" | "paused" | "ended";
export type DeliveryStatus = "draft" | "published";
export type BillingProfileType = "company" | "individual";

/** Set by the team in the admin panel; never by the client (migration 0002). */
export type ClientApprovalStatus = "pending" | "approved" | "rejected";

/** A portal login. NOT the CRM record — that is CrmClient. */
export type Client = {
  id: string;
  full_name: string;
  email: string;
  discord_handle: string | null;
  avatar_url: string | null;
  crm_client_id: string | null;
  approval_status: ClientApprovalStatus;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  /**
   * Reversible portal lockout (migration 0083). Independent of
   * approval_status: a blocked client stays approved, billable and syncing —
   * they simply cannot open the portal until the team unblocks them.
   */
  access_blocked: boolean;
  access_blocked_at: string | null;
  access_blocked_by: string | null;
  /** Stripe customer, created on this client's first invoice (migration 0013). */
  stripe_customer_id: string | null;
  /** This client's affiliate code — theirs to share (migration 0022). */
  referral_code: string | null;
  /** Whose code they used when they signed up. Set once, never edited. */
  referred_by: string | null;
};

/**
 * A sócio: another portal login that may open this client's workspace
 * (migration 0015). The OWNER is never a row here — which is what makes
 * removing them structurally impossible.
 */
export type ClientMember = {
  /** The workspace: the owner's portal_clients id. */
  client_id: string;
  /** The partner's own portal login. */
  member_id: string;
  invited_by: string | null;
  created_at: string;
};

export type ClientInviteStatus = "pending" | "accepted";

/** An invitation by email, turned into a membership by accept_client_invites(). */
export type ClientInvite = {
  id: string;
  client_id: string;
  email: string;
  invited_by: string | null;
  status: ClientInviteStatus;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
};

export type InvoiceStatus =
  "draft" | "open" | "paid" | "void" | "uncollectible" | "waived";

/** Legacy invoices may contain spend/revenue-share lines; new invoices use fee only. */
export type InvoiceLineKind = "spend" | "fee" | "rev_share" | "arrears";

/**
 * One line of what an invoice is made of — a snapshot, never re-derived.
 *
 * `label` is the English text Stripe prints on the invoice, so it is always
 * present. `kind`/`store`/`rate` are the same line broken into parts, which is
 * what lets the portal render it in the viewer's language instead of showing
 * the stored English. They are optional because rows written before this
 * existed only have the label — the UI falls back to it.
 */
export type InvoiceLine = {
  label: string;
  amount: number;
  accountId: string | null;
  kind?: InvoiceLineKind;
  /** Store name at billing time; a later rename must not rewrite history. */
  store?: string;
  /** 'arrears' lines: the retired overdue invoice this balance came from. */
  absorbedInvoiceId?: string;
  absorbedPeriodStart?: string;
  absorbedPeriodEnd?: string;
  /** Percentage the line was computed at — blended over the week. Spend: null. */
  rate?: number | null;
  /** V4 chooses exactly one source per store; manual and referral never stack. */
  pricingMode?: "manual" | "referral";
  /** Append-only account list-rate term used by this V4 fee line. */
  commissionTermId?: string | null;
  /** Standard agency list fee before the sealed manual-referral term. */
  listRate?: number;
  /** Percentage points removed by the sealed manual-referral term. */
  referralDiscountRate?: number;
  /** Number of approved referrals represented by that term. */
  referralCount?: number;
  /** Informational fee base. It is not included in the payable line amount. */
  baseAmount?: number;
  /** Raw Google spend observed for this store in the invoiced period. */
  sourceGrossAmount?: number;
  /** Opening same-day Google counter excluded from the first partial week. */
  baselineDeductionAmount?: number;
  /** Spend after the immutable closing counter, excluded from the final partial week. */
  endDeductionAmount?: number;
  /** True only for the invoice week whose spend is clipped by the closing counter. */
  endingCapApplied?: true;
  /** Full cumulative Google counter observed when tracking began. */
  billingStartBaselineAmount?: number;
  /** Immutable billing-start record that authorised this line. */
  billingStartId?: string;
  /** Which immutable opening-proof contract authorised this line. */
  billingStartBasis?: "observed_google_counter" | "reviewed_full_day";
  /** Google-local day on which billing started for this store. */
  billingStartDate?: string;
  /** UTC instant at which the opening Google counter was captured. */
  billingStartedAt?: string;
  /** IANA timezone used by the Google Ads account for the opening day. */
  billingTimeZone?: string;
  /** Immutable reviewed full-day proof used instead of an opening counter. */
  reviewedFullDayBoundaryId?: string;
  /** Reviewed full-day commercial policy frozen into this line. */
  billingPolicyVersion?: string;
  /** Lisbon commercial-entry day frozen by the reviewed policy. */
  entryDate?: string;
  /** Commercial-entry timezone frozen by the reviewed policy. */
  entryTimeZone?: string;
  /** How the reviewed policy treats the Google reporting entry day. */
  entryDayTreatment?: string;
  /** Full cumulative Google counter observed when billing ended. */
  billingEndCounterAmount?: number;
  /** Immutable billing-end record that closed this line's commercial period. */
  billingEndId?: string;
  /** Google-local day on which billing ended for this store. */
  billingEndDate?: string;
  /** UTC instant at which the closing Google counter was captured. */
  billingEndedAt?: string;
  /** IANA timezone used by the Google Ads account for the closing day. */
  billingEndTimeZone?: string;
};

/** Exact legal/email identity reviewed for a v3 invoice and frozen at creation. */
export type BillingRecipientSnapshot = {
  email: string;
  fallbackName: string;
  billingName: string | null;
  taxId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  addressState: string | null;
  addressCountry: string | null;
};

/** One immutable generation of the per-client Stripe issue lease (0032). */
export type BillingIssueLease = {
  lease_token: string;
  client_id: string;
  fencing_token: number;
  period_start: string;
  /** Null is the database's explicit automatic issuer; admins remain UUIDs. */
  issued_by: string | null;
  acquired_at: string;
  renewed_at: string;
  lease_expires_at: string;
  released_at: string | null;
};

export type BillingAutomationRunStatus =
  "running" | "succeeded" | "partial" | "failed";

/** Durable aggregate receipt for one automatic billing invocation (0036). */
export type BillingAutomationRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: BillingAutomationRunStatus;
  issuance_enabled: boolean;
  seeded_items: number;
  claimed_items: number;
  issued_items: number;
  no_charge_items: number;
  blocked_items: number;
  historical_rollovers_checked: number;
  exact_refresh_requested: number;
  exact_refresh_completed: number;
  reconciliation_checked: number;
  reconciliation_updated: number;
  error_count: number;
};

export type BillingAutomationItemState =
  "pending" | "processing" | "blocked" | "issued" | "no_charge";

export type BillingAutomationItemStage =
  "discovered" | "preview" | "google_evidence" | "stripe_issue" | "complete";

/** One fenced, retryable client/week work receipt (0036 + 0053). */
export type BillingAutomationItem = {
  id: string;
  client_id: string;
  period_start: string;
  period_end: string;
  state: BillingAutomationItemState;
  stage: BillingAutomationItemStage;
  blocker_code: string | null;
  safe_message: string | null;
  invoice_id: string | null;
  amount_snapshot: number | string | null;
  billable_spend_snapshot: number | string | null;
  evidence_account_count: number;
  attempt_count: number;
  first_seen_at: string;
  last_attempted_at: string | null;
  resolved_at: string | null;
  last_run_id: string | null;
  claimed_by_run_id: string | null;
  claim_version: number;
  claim_expires_at: string | null;
  no_charge_reason: "exact_zero" | "cycle_skipped" | null;
  billing_cycle_skip_id: string | null;
  updated_at: string;
};

/** Admin-attributed no-charge decision for one Monday-to-Sunday cycle. */
export type BillingCycleSkip = {
  id: string;
  client_id: string;
  period_start: string;
  period_end: string;
  reason: string | null;
  created_by: string;
  created_at: string;
};

/** A week's agency commission, billed to one portal client (migration 0013). */
export type Invoice = {
  id: string;
  client_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  due_date: string | null;
  line_items: InvoiceLine[];
  stripe_invoice_id: string | null;
  stripe_hosted_url: string | null;
  /** Stripe's human-readable number and PDF, available after finalisation. */
  stripe_invoice_number: string | null;
  stripe_invoice_pdf: string | null;
  /** Authoritative Stripe balance in major currency units. */
  amount_remaining: number | null;
  issued_at: string | null;
  issued_by: string | null;
  /** Last safe-to-display error from the manual issue attempt. */
  issue_error: string | null;
  issue_attempted_at: string | null;
  /** Pins the commercial formula used for this immutable snapshot. */
  calculation_version: string;
  /** Immutable manual-referral term used for this week; null means list fee. */
  referral_discount_term_id: string | null;
  /** Immutable v3 recipient snapshot; null only on older invoice contracts. */
  billing_recipient: BillingRecipientSnapshot | null;
  /** Durable evidence that Stripe accepted explicit invoice delivery. */
  stripe_sent_at: string | null;
  /** Historical safety marker when delivery predates explicit evidence. */
  stripe_delivery_assumed_at: string | null;
  paid_at: string | null;
  /** Set when Stripe reported a failed charge; cleared once it is paid (0014). */
  payment_failed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Exact ledger rows consumed by an invoice; each commission can be billed once. */
export type InvoiceCommissionRow = {
  invoice_id: string;
  commission_id: string;
  /** Raw Google-reported daily spend, before the opening baseline. */
  gross_amount: number | string;
  /** Portion of the opening day excluded because it preceded tracking. */
  baseline_deduction_amount: number | string;
  /** Immutable start boundary used to allocate this row. */
  billing_start_id: string;
  /** Immutable end boundary used for a final-day row, otherwise null. */
  billing_end_id: string | null;
  /** Portion of the final day excluded because it followed service. */
  end_deduction_amount: number | string | null;
  /** Gross amount on which the agency fee was actually calculated. */
  billable_gross_amount: number | string;
  currency: string;
  created_at: string;
};

export type ReferralDiscountAction = "grant" | "revoke";

/** Immutable singleton that bounds which weeks v3 may price (migration 0030). */
export type ManualReferralBillingConfig = {
  singleton: boolean;
  v3_cutover_monday: string;
  created_at: string;
};

/** Immutable referral-code signal awaiting independent admin review. */
export type ReferralClaimRequest = {
  id: string;
  referred_client_id: string;
  referrer_client_id: string;
  referral_code: string;
  claim_source: "signup" | "client";
  created_at: string;
};

/** Append-only receipt for a one-time referral attribution applied by an admin. */
export type ReferralAttributionEvent = {
  id: string;
  decision_id: string;
  referred_client_id: string;
  referrer_client_id: string;
  reason: string;
  reviewed_by: string;
  created_at: string;
  sealed_at: string;
};

/** Append-only, Monday-effective manual referral price snapshot. */
export type ReferralDiscountTerm = {
  id: string;
  client_id: string;
  effective_from: string;
  revision: number;
  supersedes_id: string | null;
  decision_id: string;
  decision_action: ReferralDiscountAction;
  decision_referred_client_id: string;
  expected_term_id: string | null;
  list_rate: number | string;
  referral_step_rate: number | string;
  referral_count: number;
  referral_discount_rate: number | string;
  fee_rate: number | string;
  reason: string;
  reviewed_by: string;
  created_at: string;
  sealed_at: string | null;
};

/** Append-only, Monday-effective per-store list-rate decision (0061). */
export type AdAccountCommissionTerm = {
  id: string;
  ad_account_id: string;
  effective_from: string;
  revision: number;
  supersedes_id: string | null;
  decision_id: string;
  list_rate: number | string;
  reviewed_by: string;
  created_at: string;
  sealed_at: string;
};

/** One validated referred client sealed into a referral term. */
export type ReferralDiscountTermItem = {
  id: string;
  term_id: string;
  referred_client_id: string;
  evidence_billing_start_id: string;
  evidence_commission_id: string;
  eligibility_checked_on: string;
  evidence_occurred_on: string;
  evidence_gross_amount: number | string;
  /** Positive Google spend after the immutable opening/closing boundaries. */
  evidence_billable_amount: number | string;
  created_at: string;
};

/** Exact referral grants pinned to an invoice/waived settlement. */
export type InvoiceReferralEvent = {
  invoice_id: string;
  referral_discount_term_id: string;
  referral_discount_term_item_id: string;
  created_at: string;
};

/** Proof that Google was read successfully for one exact billing period. */
export type GoogleLedgerSnapshotRow = {
  id: string;
  occurred_on: string;
  /** Decimal string with six places; never round-tripped through JSON Number. */
  gross_amount: string;
  currency: string;
  status: "confirmed";
};

export type GoogleLedgerSyncWindow = {
  ad_account_id: string;
  billing_start_id: string;
  /** Bound closing counter when this proof covers an account's final week. */
  billing_end_id: string | null;
  period_start: string;
  period_end: string;
  run_id: string;
  status: "in_progress" | "complete" | "failed";
  started_at: string;
  synced_at: string;
  ledger_snapshot: GoogleLedgerSnapshotRow[];
};

/** Immutable opening Google Ads counter that starts financial tracking. */
export type AdAccountBillingStart = {
  id: string;
  ad_account_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: string;
  start_basis: "observed_google_counter" | "reviewed_full_day";
  reviewed_full_day_boundary_id: string | null;
  /** Integer micros, or null for a reviewed full-day opening boundary. */
  baseline_cost_micros: number | string | null;
  capture_started_at: string | null;
  captured_at: string | null;
  capture_id: string | null;
  source: string | null;
  reviewed_by: string | null;
  created_at: string;
};

/** Immutable policy evidence for a reviewed full Google reporting start day. */
export type ReviewedFullDayBillingBoundary = {
  id: string;
  ad_account_id: string;
  client_id: string;
  google_ads_customer_id: string;
  account_created_at: string;
  entry_day: string;
  entry_time_zone: string;
  google_local_date: string;
  google_time_zone: string;
  entry_day_treatment: string;
  currency: string;
  cutover_monday: string;
  policy_version: string;
  metadata_capture_id: string;
  metadata_capture_started_at: string;
  metadata_captured_at: string;
  metadata_authority: string;
  metadata_contract: string;
  source_snapshot: Record<string, unknown>;
  source_fingerprint: string;
  sealed_at: string;
  sealed_by: string;
};

/** Immutable closing Google Ads counter that ends financial tracking. */
export type AdAccountBillingEnd = {
  id: string;
  ad_account_id: string;
  billing_start_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: string;
  /** Integer micros. Read as a string whenever it participates in arithmetic. */
  end_cost_micros: number | string;
  capture_started_at: string;
  captured_at: string;
  capture_id: string;
  source: string;
  reviewed_by: string;
  created_at: string;
};

/** Durable, de-duplicated Stripe webhook inbox (migration 0028). */
export type StripeWebhookEvent = {
  id: string;
  type: string;
  stripe_created_at: string;
  payload: Record<string, unknown>;
  received_at: string;
  processed_at: string | null;
  processing_error: string | null;
};

export type BillingProfile = {
  client_id: string;
  profile_type: BillingProfileType;
  currency: string;
  available_budget: number | null;
  // What the invoice has to show (migration 0020). Separate from the portal
  // login's name: the person signing in is often not the entity being billed.
  billing_name: string | null;
  /** VAT / company number, printed as an invoice custom field. */
  tax_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_postal_code: string | null;
  address_state: string | null;
  /** ISO 3166-1 alpha-2, upper-case — the shape Stripe requires. */
  address_country: string | null;
  updated_at: string;
};

export type AdAccount = {
  id: string;
  client_id: string;
  store_name: string;
  google_ads_customer_id: string | null;
  status: AdAccountStatus;
  /** Metric-source family; historical rows default to legacy_hybrid (0055). */
  reporting_role: AdAccountReportingRole;
  currency: string;
  breakeven_roas: number | null;
  lifetime_ads_budget_usd: number | null;
  shopify_url: string | null;
  shopify_connected: boolean;
  shopify_client_id: string | null;
  shopify_scopes: string | null;
  color_dot: string;
  created_at: string;
  // Per-client Google Ads OAuth (migration 0005). The token is AES-GCM
  // ciphertext and never leaves the server — the portal's list/detail selects
  // omit it, so it is not present on the AdAccount objects pages receive.
  google_ads_refresh_token: string | null;
  google_ads_connected_email: string | null;
  google_ads_connected: boolean;
  /**
   * What this store is BILLED at. Derived since migration 0022 — a trigger sets
   * it to `list_commission_rate` minus the owner's affiliate discount on every
   * write, so writing to it directly does nothing. Read it everywhere; to
   * change the price, change the list rate.
   */
  commission_rate: number;
  /** The agency's price before any affiliate discount. What the team edits. */
  list_commission_rate: number;
  // Shopify custom-app credentials (migration 0008). The token is AES-GCM
  // ciphertext, excluded from ACCOUNT_COLUMNS like the Google token; the UI
  // only ever sees shopify_token_last4.
  shopify_admin_token: string | null;
  shopify_token_last4: string | null;
  shopify_connected_at: string | null;
  // COGS / profit-chain settings (migration 0009)
  default_product_cost_pct: number;
  payment_fee_pct: number;
  payment_fee_fixed: number;
  shipping_cost_per_order: number;
  /** The supplier's own id for this shop in the HST ERP, when it has one. */
  hst_shop_id: string | null;
  // Agency revenue share (migration 0010); admin-only via the same guard.
  // Rate is not stored here — it lives in the Google Ads campaign name.
  revenue_share_enabled: boolean;
};

export type AppSecret = {
  key: string;
  ciphertext: string;
  hint: string | null;
  updated_by: string | null;
  updated_at: string;
};

export type ResearchComparison = {
  key: string;
  concept_id: string;
  geos: string[];
  run_id: string | null;
  pairs: { geo: string; kw: string }[];
  status: "running" | "done" | "error";
  payload: Record<string, unknown> | null;
  cost_usd: string | number | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditShopifyConnectionStatus = "pending" | "connected" | "revoked";

/**
 * A Shopify store linked only for internal compliance audits (migration 0040).
 * It is intentionally unrelated to ad_accounts and never enters metrics,
 * revenue, COGS, Google Ads or agency billing.
 */
export type AuditShopifyConnection = {
  id: string;
  store_label: string;
  status: AuditShopifyConnectionStatus;
  /** SHA-256 digest of a one-time bearer; service-role only and never a DTO. */
  invite_token_hash: string | null;
  invite_expires_at: string | null;
  failed_attempts: number;
  last_attempt_at: string | null;
  shopify_shop_id: string | null;
  shopify_name: string | null;
  shopify_domain: string | null;
  primary_domain: string | null;
  shopify_currency: string | null;
  shopify_client_id: string | null;
  credential_hint: string | null;
  granted_scopes: string[];
  scope_profile: "store-audit-full-v1" | "store-audit-clearance-v2";
  created_by: string;
  created_at: string;
  updated_at: string;
  connected_at: string | null;
  last_verified_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  revoked_at: string | null;
  last_error_code: string | null;
};

/** Ciphertext vault: no anon/authenticated policies, including for admins. */
export type AuditShopifyCredential = {
  connection_id: string;
  client_secret_ciphertext: string;
  updated_at: string;
};

export type AuditShopifyConnectionEvent = {
  id: string;
  connection_id: string;
  event_type:
    | "invitation_created"
    | "invitation_rotated"
    | "invitation_revoked"
    | "credentials_rejected"
    | "store_connected"
    | "connection_reviewed"
    | "connection_revoked"
    | "verification_failed"
    | "audit_collector_requested";
  actor_type: "admin" | "invite" | "system";
  actor_profile_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type AuditShopifyRunState =
  "queued" | "running" | "completed" | "failed";
export type AuditShopifyRunRequestActor = "admin" | "system";

/**
 * Durable, service-role-only state for a bounded read-only audit collector
 * (migration 0042). `checkpoint` and `artifact` are sanitized JSON objects;
 * neither may contain credential-shaped keys.
 */
export type AuditShopifyRun = {
  id: string;
  connection_id: string;
  requested_by: string;
  requested_actor_type: AuditShopifyRunRequestActor;
  shopify_domain: string;
  state: AuditShopifyRunState;
  requested_source: string;
  requested_note: string | null;
  schema_hash: string;
  manifest_hash: string;
  checkpoint: Record<string, unknown>;
  artifact: Record<string, unknown> | null;
  attempt_count: number;
  retry_count: number;
  max_retries: number;
  next_attempt_at: string | null;
  lease_token: string | null;
  lease_generation: number;
  lease_acquired_at: string | null;
  lease_renewed_at: string | null;
  lease_expires_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
};

export type AccountRequest = {
  id: string;
  client_id: string;
  request_type: RequestType;
  google_ads_customer_id: string | null;
  store_name: string | null;
  shopify_collaborator_code: string | null;
  myshopify_url: string | null;
  status: RequestStatus;
  created_at: string;
};

export type CreativeSubmissionStatus = "new" | "in_use" | "rejected";

/**
 * Creatives the CLIENT handed in (migration 0018) — the opposite direction to
 * CreativeDelivery. A link to their own Drive/Dropbox, not a stored file.
 * `status` and the review fields are the team's; a guard trigger enforces that.
 */
export type CreativeSubmission = {
  id: string;
  ad_account_id: string;
  submitted_by: string | null;
  title: string;
  url: string;
  /**
   * The Shopify collection these creatives advertise, as the client typed it.
   * The campaign built from the batch carries this URL in its name, which is
   * what attributes revenue share (migration 0010).
   */
  collection_url: string | null;
  notes: string | null;
  status: CreativeSubmissionStatus;
  review_notes: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
};

export type Campaign = {
  id: string;
  ad_account_id: string;
  name: string;
  status: CampaignStatus;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  daily_budget: number | null;
  updated_at: string;
  /**
   * Billing currency the money figures are in, when it differs from the ad
   * account's reporting currency — campaign reads come straight from Google in
   * the account's NATIVE currency and are never FX-converted (they are range
   * aggregates, so no per-day rate applies). Absent on legacy rows, where the
   * two currencies are guaranteed equal.
   */
  currency?: string;
};

export type CampaignAction =
  | "budget_changed"
  | "campaign_paused"
  | "campaign_enabled"
  | "campaign_launched";
export type CampaignActionPolicyAction = Exclude<
  CampaignAction,
  "campaign_launched"
>;
export type CampaignActionOperationStatus =
  "requested" | "succeeded" | "failed" | "uncertain";

/** Append-only, default-deny campaign write authority (migration 0059). */
export type CampaignActionPolicy = {
  id: string;
  client_reporting_binding_id: string;
  supersedes_policy_id: string | null;
  revision: number;
  executor: "agency_google";
  allowed_actions: CampaignActionPolicyAction[];
  /** Integer Google Ads DAILY budget micros; keep as a string for arithmetic. */
  max_daily_budget_micros: number | string | null;
  idempotency_key: string;
  configured_by: string;
  reason: string;
  created_at: string;
};

/** One request-to-terminal Google Ads mutation lifecycle (migration 0059). */
export type CampaignActionOperation = {
  id: string;
  idempotency_key: string;
  execution_claim_id: string;
  client_id: string;
  client_reporting_binding_id: string;
  client_google_ads_connection_id: string;
  shopify_anchor_binding_id: string | null;
  shopify_anchor_ad_account_id: string | null;
  ad_account_id: string;
  billing_start_id: string;
  campaign_action_policy_id: string;
  policy_revision: number;
  executor: "agency_google";
  google_ads_customer_id: string;
  google_time_zone: string;
  currency: string;
  provider_campaign_id: string;
  campaign_name: string;
  action: CampaignAction;
  status: CampaignActionOperationStatus;
  previous_status: "active" | "paused" | null;
  next_status: "active" | "paused" | null;
  previous_daily_budget_micros: number | string | null;
  next_daily_budget_micros: number | string | null;
  requested_details: Json;
  request_snapshot: Json;
  request_hash: string;
  requested_by: string;
  requested_at: string;
  observed_status: "active" | "paused" | "ended" | null;
  observed_daily_budget_micros: number | string | null;
  result_details: Json | null;
  completed_at: string | null;
};

/** One pre-aggregated day for one store (migration 0008). */
export type DailyMetric = {
  ad_account_id: string;
  day: string;
  ad_spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
  revenue: number;
  orders_count: number;
  /** Line-item quantities sold that day (migration 0016). Not netted against
   *  refunds — refunds_amount is money, and per-line refund quantities are not
   *  fetched. */
  units_sold: number;
  /**
   * Real orders minus the ones Instagram/Facebook referred (migration 0019) —
   * the store's conversions figure, the one shown beside Google ad spend.
   *
   * Nullable with no default, and the distinction carries meaning: NULL is "no
   * sync has ever computed this day" (which the backfill in recompute.ts looks
   * for), 0 is "computed, and every order that day came from Meta".
   */
  attributed_orders: number | null;
  /**
   * Gross revenue of those orders (migration 0019), reporting currency — the
   * conversion value shown beside the count. Same NULL semantics.
   */
  attributed_revenue: number | null;
  refunds_amount: number;
  // Cost side of the profit chain (migration 0009), reporting currency.
  product_cost: number;
  payment_fees: number;
  shipping_cost: number;
  // Revenue share (migration 0010), reporting currency.
  revenue_share_base: number;
  revenue_share_amount: number;
  computed_at: string;
  // The revenue side in the STORE's own base currency (migration 0092), the
  // untouched Shopify figures — converted to a display currency only at read
  // time. Null before 0092 / for rows a sync has not re-touched since.
  revenue_store: number | null;
  refunds_store: number | null;
  attributed_revenue_store: number | null;
  /** The store's base currency the *_store columns are in (e.g. "JPY"). */
  store_currency: string | null;
};

// HST supplier-commission integration (migration 0011). Single-row config.
export type HstIntegration = {
  id: boolean;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  /** AES-GCM credentials, so an expired refresh token is not the end (0088). */
  username_enc: string | null;
  password_enc: string | null;
  /** Last sync that actually landed rows. Drives the cross-instance throttle. */
  last_synced_at: string | null;
  // Sync health (migration 0017). last_attempt_at moves on every attempt, so
  // "the cron never ran" and "the cron ran and HST refused" stop looking alike;
  // last_error is the reason, cleared on success, and is shown on the HST page.
  last_attempt_at: string | null;
  last_error: string | null;
  updated_at: string;
};

/**
 * One payment RECEIVED from HST (migration 0012). The commission ledger is
 * republished on every sync, so settlement lives here: `covers_through` marks
 * which commission days a payment settles.
 */
export type HstPayment = {
  id: string;
  paid_on: string;
  amount: number;
  covers_through: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type CreativeDelivery = {
  id: string;
  ad_account_id: string;
  name: string;
  status: DeliveryStatus;
  file_count: number;
  size_mb: number;
  thumbnail_urls: string[];
  created_at: string;
};

// ---------------------------------------------------------------------------
// COGS (migration 0009)
// ---------------------------------------------------------------------------

export type StoreProduct = {
  id: string;
  ad_account_id: string;
  platform_key: string;
  title: string;
  price: number;
  currency: string;
  source: "orders" | "catalog";
  last_seen: string;
  created_at: string;
};

export type ProductCost = {
  id: string;
  product_id: string;
  cost: number;
  currency: string;
  effective_from: string;
  /** Who decided this cost: the merchant, or the HST supplier feed. */
  source: "manual" | "hst";
  created_at: string;
};

/**
 * One client's own HST login (migration 0089).
 *
 * Distinct from hst_integration, which is the AGENCY's session for reading the
 * commission HST pays it. This one prices a client's own goods, sees only their
 * shop, and is reachable exclusively by the service role — the table has RLS on
 * and no policies at all.
 */
export type ClientHstCredentials = {
  client_id: string;
  username_enc: string;
  password_enc: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_error: string | null;
  connected_at: string;
  updated_at: string;
  /** Cached HST shop list (0090), so the dropdown renders without a live call. */
  shops: Json | null;
};

export type HstOrderCharge = {
  ad_account_id: string;
  platform_order_id: string;
  order_day: string;
  /** The instant behind order_day, so the day can be re-derived per store zone. */
  paid_at: string | null;
  tariff: number;
  /** The supplier's total charge for this order (goods + tariff), 0091. */
  our_cost: number | null;
  currency: string;
  synced_at: string;
};

export type ProductCostTier = {
  id: string;
  product_id: string;
  min_qty: number;
  total_cost: number;
};

export type CogsCollectionRow = {
  id: string;
  ad_account_id: string;
  name: string;
  created_at: string;
};

export type CogsCollectionMember = {
  collection_id: string;
  product_id: string;
};

export type CogsCollectionTier = {
  id: string;
  collection_id: string;
  min_qty: number;
  total_cost: number;
};

// ---------------------------------------------------------------------------
// Client onboarding V2 (purpose-bound; parallel to legacy ad_accounts)
// ---------------------------------------------------------------------------

export type ClientOnboardingMode = "new_client" | "add_assets" | "reconnect";
export type ClientOnboardingAsset = "shopify" | "google_ads";
export type ClientShopifyReconnectTargetSource = "legacy" | "onboarding";
export type ClientOnboardingStatus =
  "pending" | "collecting" | "submitted" | "reviewed" | "active" | "revoked";

export type ClientOnboardingSession = {
  id: string;
  mode: ClientOnboardingMode;
  requested_assets: ClientOnboardingAsset[];
  status: ClientOnboardingStatus;
  invite_token_hash: string | null;
  invite_expires_at: string | null;
  failed_attempts: number;
  last_attempt_at: string | null;
  target_client_id: string | null;
  reconnect_legacy_ad_account_id: string | null;
  reconnect_shopify_connection_id: string | null;
  reconnect_completed_at: string | null;
  claimed_user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  discord_handle: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  identity_created_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  activated_at: string | null;
  revoked_at: string | null;
  last_error_code: string | null;
};

export type ClientOnboardingSecret = {
  session_id: string;
  windsor_access_token_ciphertext: string | null;
  updated_at: string;
};

export type ClientShopifyConnection = {
  id: string;
  session_id: string;
  client_id: string;
  status: "connected" | "revoked";
  shopify_shop_id: string;
  shopify_name: string;
  shopify_domain: string;
  primary_domain: string | null;
  shopify_currency: string;
  credential_hint: string | null;
  granted_scopes: string[];
  scope_profile: "client-reporting-read-v1";
  created_at: string;
  updated_at: string;
  connected_at: string;
  last_verified_at: string | null;
  revoked_at: string | null;
  last_error_code: string | null;
};

export type ClientShopifyCredential = {
  connection_id: string;
  shopify_client_id: string;
  client_secret_ciphertext: string;
  updated_at: string;
};

export type ClientGoogleAdsConnection = {
  id: string;
  session_id: string;
  client_id: string;
  status: "connected" | "revoked";
  windsor_account_id: string;
  /** What Windsor reported. Empty for an account it has no name for. */
  account_name: string;
  /** The name the team gave it, which wins over Windsor's wherever it shows. */
  admin_label: string | null;
  admin_label_set_by: string | null;
  admin_label_set_at: string | null;
  currency: string | null;
  time_zone: string | null;
  data_source_id: string | null;
  created_at: string;
  updated_at: string;
  connected_at: string;
  last_verified_at: string | null;
  revoked_at: string | null;
  last_error_code: string | null;
};

export type ClientAssetMapping = {
  id: string;
  session_id: string;
  shopify_connection_id: string;
  google_ads_connection_id: string;
  created_at: string;
};

export type ClientRolloutState = {
  client_id: string;
  operational_surface:
    | "legacy_only"
    | "v2_onboarding"
    | "v2_ready_for_cutover"
    | "v2_active"
    | "rollback_legacy";
  onboarding_session_id: string | null;
  reporting_cutover_at: string | null;
  reporting_cutover_by: string | null;
  reporting_cutover_reason: string | null;
  updated_by: string | null;
  updated_at: string;
};

export type ClientOnboardingEvent = {
  id: string;
  session_id: string;
  event_type:
    | "invitation_created"
    | "invitation_rotated"
    | "identity_claimed"
    | "shopify_connected"
    | "google_connected"
    | "assets_mapped"
    | "submitted"
    | "reviewed"
    | "activated"
    | "reporting_rollback"
    | "reporting_reactivation"
    | "invitation_revoked"
    | "connections_revoked"
    | "verification_succeeded"
    | "verification_failed";
  actor_type: "admin" | "invite" | "client" | "system";
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type ClientReportingBindingStatus = "staged" | "active" | "revoked";
export type ClientReportingBinding = {
  id: string;
  client_id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: ClientReportingBindingStatus;
  idempotency_key: string;
  bound_reason: string;
  bound_by: string;
  bound_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
};

export type ClientReportingBindingEvent = {
  id: string;
  binding_id: string;
  event_type: "bound" | "staged" | "promoted" | "abandoned" | "revoked";
  idempotency_key: string;
  actor_id: string;
  reason: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type ClientReportingAnchorEvent = {
  id: string;
  binding_id: string;
  prior_binding_id: string | null;
  ad_account_id: string;
  event_type:
    | "provisioned"
    | "adopted"
    | "upgraded"
    | "restaged"
    | "source_added"
    | "source_abandoned";
  idempotency_key: string;
  actor_id: string;
  reason: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type ClientReportingSyncSource = "shopify" | "google_ads";
export type ClientReportingSyncState = {
  binding_id: string;
  source_type: ClientReportingSyncSource;
  last_success_at: string;
  last_success_from: string;
  last_success_to: string;
  source_currency: string;
  row_count: number;
};

export type AdminReportingSnapshotFamily =
  | "google_campaigns"
  | "store_campaign_performance"
  | "shopify_funnel"
  | "shopify_collection_sales";

export type AdminReportingRangeSnapshot = {
  family: AdminReportingSnapshotFamily;
  scope_account_id: string;
  from_day: string;
  to_day: string;
  authority_key: string;
  authority_manifest: Json;
  state: "ready" | "partial" | "empty" | "unavailable" | null;
  payload: Json | null;
  message: string | null;
  last_success_at: string | null;
  last_attempt_at: string;
  last_error_code: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  revision: number;
};

export type ClientGoogleAdsReportingIdentityEvent = {
  id: string;
  connection_id: string;
  prior_currency: string | null;
  source_currency: string;
  prior_time_zone: string | null;
  source_time_zone: string;
  verified_at: string;
  actor_id: string;
  created_at: string;
};

export type ClientGoogleAdsReportingMetadataEvent = {
  id: string;
  connection_id: string;
  client_id: string;
  binding_id: string | null;
  event_type: "metadata_enriched";
  proof_scope: "windsor_reporting_metadata_only";
  source_account_id: string;
  prior_currency: string | null;
  source_currency: string;
  prior_time_zone: string | null;
  source_time_zone: string;
  verified_at: string;
  actor_id: string;
  reason: string;
  idempotency_key: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Database map
// ---------------------------------------------------------------------------

type Row<T> = T;
type Insert<T, Optional extends keyof T> = Omit<T, Optional> &
  Partial<Pick<T, Optional>>;

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Row<Profile>;
        Insert: Insert<Profile, "avatar_url" | "role" | "created_at">;
        Update: Partial<Profile>;
        Relationships: [];
      };
      boards: {
        Row: Row<Board>;
        Insert: Insert<Board, "id" | "created_by" | "created_at">;
        Update: Partial<Board>;
        Relationships: [
          {
            foreignKeyName: "boards_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      board_columns: {
        Row: Row<BoardColumn>;
        Insert: Insert<BoardColumn, "id" | "position">;
        Update: Partial<BoardColumn>;
        Relationships: [
          {
            foreignKeyName: "board_columns_board_id_fkey";
            columns: ["board_id"];
            isOneToOne: false;
            referencedRelation: "boards";
            referencedColumns: ["id"];
          },
        ];
      };
      cards: {
        Row: Row<Card>;
        Insert: Insert<
          Card,
          | "id"
          | "description"
          | "priority"
          | "labels"
          | "due_date"
          | "position"
          | "created_by"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<Card>;
        Relationships: [
          {
            foreignKeyName: "cards_column_id_fkey";
            columns: ["column_id"];
            isOneToOne: false;
            referencedRelation: "board_columns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cards_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      card_assignees: {
        Row: Row<CardAssignee>;
        Insert: Row<CardAssignee>;
        Update: Partial<CardAssignee>;
        Relationships: [
          {
            foreignKeyName: "card_assignees_card_id_fkey";
            columns: ["card_id"];
            isOneToOne: false;
            referencedRelation: "cards";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "card_assignees_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      card_comments: {
        Row: Row<CardComment>;
        Insert: Insert<CardComment, "id" | "author_id" | "created_at">;
        Update: Partial<CardComment>;
        Relationships: [
          {
            foreignKeyName: "card_comments_card_id_fkey";
            columns: ["card_id"];
            isOneToOne: false;
            referencedRelation: "cards";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "card_comments_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      clients: {
        Row: Row<CrmClient>;
        Insert: Insert<
          CrmClient,
          "id" | "email" | "status" | "notes" | "created_by" | "created_at"
        >;
        Update: Partial<CrmClient>;
        Relationships: [
          {
            foreignKeyName: "clients_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      revenue_sources: {
        Row: Row<RevenueSource>;
        Insert: Insert<
          RevenueSource,
          | "id"
          | "category"
          | "default_rate"
          | "recurring"
          | "active"
          | "notes"
          | "created_at"
        >;
        Update: Partial<RevenueSource>;
        Relationships: [];
      };
      commissions: {
        Row: Row<Commission>;
        Insert: Insert<
          Commission,
          | "id"
          | "client_id"
          | "occurred_on"
          | "gross_amount"
          | "rate"
          | "currency"
          | "status"
          | "notes"
          | "created_by"
          | "created_at"
          | "updated_at"
          | "ad_account_id"
        >;
        Update: Partial<Commission>;
        Relationships: [
          {
            foreignKeyName: "commissions_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "revenue_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commissions_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
        ];
      };
      expenses: {
        Row: Row<Expense>;
        Insert: Insert<
          Expense,
          | "id"
          | "category"
          | "vendor"
          | "description"
          | "incurred_on"
          | "currency"
          | "recurring"
          | "created_by"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<Expense>;
        Relationships: [];
      };
      invoices: {
        Row: Row<Invoice>;
        Insert: Insert<
          Invoice,
          | "id"
          | "currency"
          | "status"
          | "due_date"
          | "line_items"
          | "stripe_invoice_id"
          | "stripe_hosted_url"
          | "stripe_invoice_number"
          | "stripe_invoice_pdf"
          | "amount_remaining"
          | "issued_at"
          | "issued_by"
          | "issue_error"
          | "issue_attempted_at"
          | "calculation_version"
          | "referral_discount_term_id"
          | "billing_recipient"
          | "stripe_sent_at"
          | "stripe_delivery_assumed_at"
          | "paid_at"
          | "payment_failed_at"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<Invoice>;
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_issued_by_fkey";
            columns: ["issued_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_referral_discount_term_id_fkey";
            columns: ["referral_discount_term_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_terms";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_issue_leases: {
        Row: Row<BillingIssueLease>;
        Insert: Row<BillingIssueLease>;
        Update: Partial<BillingIssueLease>;
        Relationships: [
          {
            foreignKeyName: "billing_issue_leases_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_issue_leases_issued_by_fkey";
            columns: ["issued_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_automation_runs: {
        Row: Row<BillingAutomationRun>;
        Insert: Insert<
          BillingAutomationRun,
          | "id"
          | "started_at"
          | "finished_at"
          | "status"
          | "seeded_items"
          | "claimed_items"
          | "issued_items"
          | "no_charge_items"
          | "blocked_items"
          | "historical_rollovers_checked"
          | "exact_refresh_requested"
          | "exact_refresh_completed"
          | "reconciliation_checked"
          | "reconciliation_updated"
          | "error_count"
        >;
        Update: Partial<BillingAutomationRun>;
        Relationships: [];
      };
      billing_automation_items: {
        Row: Row<BillingAutomationItem>;
        Insert: Insert<
          BillingAutomationItem,
          | "id"
          | "state"
          | "stage"
          | "blocker_code"
          | "safe_message"
          | "invoice_id"
          | "amount_snapshot"
          | "billable_spend_snapshot"
          | "evidence_account_count"
          | "attempt_count"
          | "first_seen_at"
          | "last_attempted_at"
          | "resolved_at"
          | "last_run_id"
          | "claimed_by_run_id"
          | "claim_version"
          | "claim_expires_at"
          | "no_charge_reason"
          | "billing_cycle_skip_id"
          | "updated_at"
        >;
        Update: Partial<BillingAutomationItem>;
        Relationships: [
          {
            foreignKeyName: "billing_automation_items_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_automation_items_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: true;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_automation_items_last_run_id_fkey";
            columns: ["last_run_id"];
            isOneToOne: false;
            referencedRelation: "billing_automation_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_automation_items_claimed_by_run_id_fkey";
            columns: ["claimed_by_run_id"];
            isOneToOne: false;
            referencedRelation: "billing_automation_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_cycle_skips: {
        Row: Row<BillingCycleSkip>;
        Insert: Insert<BillingCycleSkip, "id" | "reason" | "created_at">;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "billing_cycle_skips_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_cycle_skips_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_onboarding_sessions: {
        Row: Row<ClientOnboardingSession>;
        Insert: Insert<
          ClientOnboardingSession,
          | "status"
          | "invite_token_hash"
          | "invite_expires_at"
          | "failed_attempts"
          | "last_attempt_at"
          | "target_client_id"
          | "reconnect_legacy_ad_account_id"
          | "reconnect_shopify_connection_id"
          | "reconnect_completed_at"
          | "claimed_user_id"
          | "first_name"
          | "last_name"
          | "email"
          | "discord_handle"
          | "created_at"
          | "updated_at"
          | "identity_created_at"
          | "submitted_at"
          | "reviewed_at"
          | "reviewed_by"
          | "activated_at"
          | "revoked_at"
          | "last_error_code"
        >;
        Update: Partial<ClientOnboardingSession>;
        Relationships: [
          {
            foreignKeyName: "client_onboarding_sessions_target_client_id_fkey";
            columns: ["target_client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_onboarding_sessions_reconnect_legacy_ad_account_id_fkey";
            columns: ["reconnect_legacy_ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_onboarding_sessions_reconnect_shopify_connection_id_fkey";
            columns: ["reconnect_shopify_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_shopify_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_onboarding_sessions_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_onboarding_sessions_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_onboarding_secrets: {
        Row: Row<ClientOnboardingSecret>;
        Insert: Insert<
          ClientOnboardingSecret,
          "windsor_access_token_ciphertext" | "updated_at"
        >;
        Update: Partial<ClientOnboardingSecret>;
        Relationships: [
          {
            foreignKeyName: "client_onboarding_secrets_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: true;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      client_shopify_connections: {
        Row: Row<ClientShopifyConnection>;
        Insert: Insert<
          ClientShopifyConnection,
          | "id"
          | "status"
          | "primary_domain"
          | "credential_hint"
          | "granted_scopes"
          | "scope_profile"
          | "created_at"
          | "updated_at"
          | "connected_at"
          | "last_verified_at"
          | "revoked_at"
          | "last_error_code"
        >;
        Update: Partial<ClientShopifyConnection>;
        Relationships: [
          {
            foreignKeyName: "client_shopify_connections_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      client_shopify_credentials: {
        Row: Row<ClientShopifyCredential>;
        Insert: Insert<ClientShopifyCredential, "updated_at">;
        Update: Partial<ClientShopifyCredential>;
        Relationships: [
          {
            foreignKeyName: "client_shopify_credentials_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: true;
            referencedRelation: "client_shopify_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      client_google_ads_connections: {
        Row: Row<ClientGoogleAdsConnection>;
        Insert: Insert<
          ClientGoogleAdsConnection,
          | "id"
          | "status"
          | "admin_label"
          | "admin_label_set_by"
          | "admin_label_set_at"
          | "currency"
          | "time_zone"
          | "data_source_id"
          | "created_at"
          | "updated_at"
          | "connected_at"
          | "last_verified_at"
          | "revoked_at"
          | "last_error_code"
        >;
        Update: Partial<ClientGoogleAdsConnection>;
        Relationships: [
          {
            foreignKeyName: "client_google_ads_connections_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      client_asset_mappings: {
        Row: Row<ClientAssetMapping>;
        Insert: Insert<ClientAssetMapping, "id" | "created_at">;
        Update: Partial<ClientAssetMapping>;
        Relationships: [
          {
            foreignKeyName: "client_asset_mappings_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_asset_mappings_shopify_connection_id_fkey";
            columns: ["shopify_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_shopify_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_asset_mappings_google_ads_connection_id_fkey";
            columns: ["google_ads_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_google_ads_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      client_rollout_states: {
        Row: Row<ClientRolloutState>;
        Insert: Insert<
          ClientRolloutState,
          | "operational_surface"
          | "onboarding_session_id"
          | "reporting_cutover_at"
          | "reporting_cutover_by"
          | "reporting_cutover_reason"
          | "updated_by"
          | "updated_at"
        >;
        Update: Partial<ClientRolloutState>;
        Relationships: [
          {
            foreignKeyName: "client_rollout_states_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: true;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_rollout_states_onboarding_session_id_fkey";
            columns: ["onboarding_session_id"];
            isOneToOne: false;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_rollout_states_reporting_cutover_by_fkey";
            columns: ["reporting_cutover_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_onboarding_events: {
        Row: Row<ClientOnboardingEvent>;
        Insert: Insert<
          ClientOnboardingEvent,
          "id" | "actor_id" | "details" | "created_at"
        >;
        Update: Partial<ClientOnboardingEvent>;
        Relationships: [
          {
            foreignKeyName: "client_onboarding_events_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "client_onboarding_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      client_reporting_bindings: {
        Row: Row<ClientReportingBinding>;
        Insert: Insert<
          ClientReportingBinding,
          | "id"
          | "shopify_connection_id"
          | "google_ads_connection_id"
          | "shopify_anchor_binding_id"
          | "status"
          | "bound_at"
          | "revoked_by"
          | "revoked_at"
          | "revoke_reason"
        >;
        Update: Partial<ClientReportingBinding>;
        Relationships: [
          {
            foreignKeyName: "client_reporting_bindings_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_shopify_connection_id_fkey";
            columns: ["shopify_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_shopify_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_google_ads_connection_id_fkey";
            columns: ["google_ads_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_google_ads_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_shopify_anchor_binding_id_fkey";
            columns: ["shopify_anchor_binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_bound_by_fkey";
            columns: ["bound_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_bindings_revoked_by_fkey";
            columns: ["revoked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_reporting_binding_events: {
        Row: Row<ClientReportingBindingEvent>;
        Insert: Insert<
          ClientReportingBindingEvent,
          "id" | "details" | "created_at"
        >;
        Update: Partial<ClientReportingBindingEvent>;
        Relationships: [
          {
            foreignKeyName: "client_reporting_binding_events_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_binding_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_reporting_anchor_events: {
        Row: Row<ClientReportingAnchorEvent>;
        Insert: Insert<
          ClientReportingAnchorEvent,
          "id" | "prior_binding_id" | "details" | "created_at"
        >;
        Update: Partial<ClientReportingAnchorEvent>;
        Relationships: [
          {
            foreignKeyName: "client_reporting_anchor_events_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_anchor_events_prior_binding_id_fkey";
            columns: ["prior_binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_anchor_events_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_reporting_anchor_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_reporting_sync_states: {
        Row: Row<ClientReportingSyncState>;
        Insert: Row<ClientReportingSyncState>;
        Update: Partial<ClientReportingSyncState>;
        Relationships: [
          {
            foreignKeyName: "client_reporting_sync_states_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
        ];
      };
      admin_reporting_range_snapshots: {
        Row: Row<AdminReportingRangeSnapshot>;
        Insert: Insert<
          AdminReportingRangeSnapshot,
          | "state"
          | "payload"
          | "message"
          | "last_success_at"
          | "last_attempt_at"
          | "last_error_code"
          | "lease_token"
          | "lease_expires_at"
          | "revision"
        >;
        Update: Partial<AdminReportingRangeSnapshot>;
        Relationships: [
          {
            foreignKeyName: "admin_reporting_range_snapshots_scope_account_id_fkey";
            columns: ["scope_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      client_google_ads_reporting_identity_events: {
        Row: Row<ClientGoogleAdsReportingIdentityEvent>;
        Insert: Insert<
          ClientGoogleAdsReportingIdentityEvent,
          "id" | "created_at"
        >;
        Update: Partial<ClientGoogleAdsReportingIdentityEvent>;
        Relationships: [
          {
            foreignKeyName: "client_google_ads_reporting_identity_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "client_google_ads_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_google_ads_reporting_identity_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_google_ads_reporting_metadata_events: {
        Row: Row<ClientGoogleAdsReportingMetadataEvent>;
        Insert: Insert<
          ClientGoogleAdsReportingMetadataEvent,
          "id" | "event_type" | "proof_scope" | "created_at"
        >;
        Update: Partial<ClientGoogleAdsReportingMetadataEvent>;
        Relationships: [
          {
            foreignKeyName: "client_google_ads_reporting_metadata_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "client_google_ads_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_google_ads_reporting_metadata_events_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_google_ads_reporting_metadata_events_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_google_ads_reporting_metadata_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      app_secrets: {
        Row: Row<AppSecret>;
        Insert: Insert<AppSecret, "hint" | "updated_by" | "updated_at">;
        Update: Partial<Insert<AppSecret, "hint" | "updated_by" | "updated_at">>;
        Relationships: [];
      };
      admin_server_errors: {
        Row: {
          id: string;
          scope: string;
          message: string;
          stack: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          scope: string;
          message: string;
          stack?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          scope?: string;
          message?: string;
          stack?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      research_comparisons: {
        Row: Row<ResearchComparison>;
        Insert: Insert<
          ResearchComparison,
          | "run_id"
          | "status"
          | "payload"
          | "cost_usd"
          | "error"
          | "created_by"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<
          Insert<
            ResearchComparison,
            | "run_id"
            | "status"
            | "payload"
            | "cost_usd"
            | "error"
            | "created_by"
            | "created_at"
            | "updated_at"
          >
        >;
        Relationships: [];
      };
      audit_shopify_connections: {
        Row: Row<AuditShopifyConnection>;
        Insert: Insert<
          AuditShopifyConnection,
          | "id"
          | "status"
          | "failed_attempts"
          | "last_attempt_at"
          | "shopify_shop_id"
          | "shopify_name"
          | "shopify_domain"
          | "primary_domain"
          | "shopify_currency"
          | "shopify_client_id"
          | "credential_hint"
          | "granted_scopes"
          | "scope_profile"
          | "created_at"
          | "updated_at"
          | "connected_at"
          | "last_verified_at"
          | "reviewed_at"
          | "reviewed_by"
          | "revoked_at"
          | "last_error_code"
        >;
        Update: Partial<AuditShopifyConnection>;
        Relationships: [
          {
            foreignKeyName: "audit_shopify_connections_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_shopify_connections_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_shopify_credentials: {
        Row: Row<AuditShopifyCredential>;
        Insert: Insert<AuditShopifyCredential, "updated_at">;
        Update: Partial<AuditShopifyCredential>;
        Relationships: [
          {
            foreignKeyName: "audit_shopify_credentials_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: true;
            referencedRelation: "audit_shopify_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_shopify_connection_events: {
        Row: Row<AuditShopifyConnectionEvent>;
        Insert: Insert<
          AuditShopifyConnectionEvent,
          "id" | "actor_profile_id" | "details" | "created_at"
        >;
        Update: Partial<AuditShopifyConnectionEvent>;
        Relationships: [
          {
            foreignKeyName: "audit_shopify_connection_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "audit_shopify_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_shopify_connection_events_actor_profile_id_fkey";
            columns: ["actor_profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_shopify_runs: {
        Row: Row<AuditShopifyRun>;
        Insert: Insert<
          AuditShopifyRun,
          | "state"
          | "requested_actor_type"
          | "requested_note"
          | "checkpoint"
          | "artifact"
          | "attempt_count"
          | "retry_count"
          | "max_retries"
          | "next_attempt_at"
          | "lease_token"
          | "lease_generation"
          | "lease_acquired_at"
          | "lease_renewed_at"
          | "lease_expires_at"
          | "error_code"
          | "created_at"
          | "updated_at"
          | "started_at"
          | "completed_at"
          | "failed_at"
        >;
        Update: Partial<AuditShopifyRun>;
        Relationships: [
          {
            foreignKeyName: "audit_shopify_runs_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "audit_shopify_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_shopify_runs_requested_by_fkey";
            columns: ["requested_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_commission_rows: {
        Row: Row<InvoiceCommissionRow>;
        Insert: Insert<InvoiceCommissionRow, "created_at">;
        Update: Partial<InvoiceCommissionRow>;
        Relationships: [
          {
            foreignKeyName: "invoice_commission_rows_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_commission_rows_commission_id_fkey";
            columns: ["commission_id"];
            isOneToOne: true;
            referencedRelation: "commissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_commission_rows_billing_start_id_fkey";
            columns: ["billing_start_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_starts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_commission_rows_billing_end_id_fkey";
            columns: ["billing_end_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_ends";
            referencedColumns: ["id"];
          },
        ];
      };
      manual_referral_billing_config: {
        Row: Row<ManualReferralBillingConfig>;
        Insert: Insert<ManualReferralBillingConfig, "singleton" | "created_at">;
        Update: Partial<ManualReferralBillingConfig>;
        Relationships: [];
      };
      referral_claim_requests: {
        Row: Row<ReferralClaimRequest>;
        Insert: Insert<ReferralClaimRequest, "id" | "created_at">;
        Update: Partial<ReferralClaimRequest>;
        Relationships: [
          {
            foreignKeyName: "referral_claim_requests_referred_client_id_fkey";
            columns: ["referred_client_id"];
            isOneToOne: true;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_claim_requests_referrer_client_id_fkey";
            columns: ["referrer_client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      referral_discount_terms: {
        Row: Row<ReferralDiscountTerm>;
        Insert: Insert<ReferralDiscountTerm, "id" | "created_at" | "sealed_at">;
        Update: Partial<ReferralDiscountTerm>;
        Relationships: [
          {
            foreignKeyName: "referral_discount_terms_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_terms_supersedes_id_fkey";
            columns: ["supersedes_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_terms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_terms_expected_term_id_fkey";
            columns: ["expected_term_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_terms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_terms_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_terms_decision_referred_client_id_fkey";
            columns: ["decision_referred_client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      referral_attribution_events: {
        Row: Row<ReferralAttributionEvent>;
        Insert: Insert<
          ReferralAttributionEvent,
          "id" | "created_at" | "sealed_at"
        >;
        Update: Partial<ReferralAttributionEvent>;
        Relationships: [
          {
            foreignKeyName: "referral_attribution_events_referred_client_id_fkey";
            columns: ["referred_client_id"];
            isOneToOne: true;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_attribution_events_referrer_client_id_fkey";
            columns: ["referrer_client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_attribution_events_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      referral_discount_term_items: {
        Row: Row<ReferralDiscountTermItem>;
        Insert: Insert<ReferralDiscountTermItem, "id" | "created_at">;
        Update: Partial<ReferralDiscountTermItem>;
        Relationships: [
          {
            foreignKeyName: "referral_discount_term_items_term_id_fkey";
            columns: ["term_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_terms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_term_items_referred_client_id_fkey";
            columns: ["referred_client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_term_items_evidence_billing_start_id_fkey";
            columns: ["evidence_billing_start_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_starts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_discount_term_items_evidence_commission_id_fkey";
            columns: ["evidence_commission_id"];
            isOneToOne: false;
            referencedRelation: "commissions";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_referral_events: {
        Row: Row<InvoiceReferralEvent>;
        Insert: Insert<InvoiceReferralEvent, "created_at">;
        Update: Partial<InvoiceReferralEvent>;
        Relationships: [
          {
            foreignKeyName: "invoice_referral_events_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_referral_events_referral_discount_term_id_fkey";
            columns: ["referral_discount_term_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_terms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_referral_events_referral_discount_term_item_id_fkey";
            columns: ["referral_discount_term_item_id"];
            isOneToOne: false;
            referencedRelation: "referral_discount_term_items";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_account_billing_starts: {
        Row: Row<AdAccountBillingStart>;
        Insert: Insert<AdAccountBillingStart, "id" | "created_at">;
        Update: Partial<AdAccountBillingStart>;
        Relationships: [
          {
            foreignKeyName: "ad_account_billing_starts_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: true;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_account_billing_starts_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      reviewed_full_day_billing_boundaries: {
        Row: Row<ReviewedFullDayBillingBoundary>;
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "reviewed_full_day_billing_boundaries_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: true;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reviewed_full_day_billing_boundaries_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_account_billing_ends: {
        Row: Row<AdAccountBillingEnd>;
        Insert: Insert<AdAccountBillingEnd, "id" | "created_at">;
        Update: Partial<AdAccountBillingEnd>;
        Relationships: [
          {
            foreignKeyName: "ad_account_billing_ends_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: true;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_account_billing_ends_billing_start_id_fkey";
            columns: ["billing_start_id"];
            isOneToOne: true;
            referencedRelation: "ad_account_billing_starts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_account_billing_ends_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      google_ledger_sync_windows: {
        Row: Row<GoogleLedgerSyncWindow>;
        Insert: Insert<
          GoogleLedgerSyncWindow,
          | "billing_end_id"
          | "run_id"
          | "status"
          | "started_at"
          | "synced_at"
          | "ledger_snapshot"
        >;
        Update: Partial<GoogleLedgerSyncWindow>;
        Relationships: [
          {
            foreignKeyName: "google_ledger_sync_windows_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_ledger_sync_windows_billing_start_id_fkey";
            columns: ["billing_start_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_starts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_ledger_sync_windows_billing_end_id_fkey";
            columns: ["billing_end_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_ends";
            referencedColumns: ["id"];
          },
        ];
      };
      stripe_webhook_events: {
        Row: Row<StripeWebhookEvent>;
        Insert: Insert<
          StripeWebhookEvent,
          "received_at" | "processed_at" | "processing_error"
        >;
        Update: Partial<StripeWebhookEvent>;
        Relationships: [];
      };
      portal_clients: {
        Row: Row<Client>;
        Insert: Insert<
          Client,
          | "avatar_url"
          | "crm_client_id"
          | "approval_status"
          | "approved_at"
          | "approved_by"
          | "created_at"
          | "stripe_customer_id"
          | "referral_code"
          | "referred_by"
          | "discord_handle"
        >;
        Update: Partial<Client>;
        Relationships: [
          {
            foreignKeyName: "portal_clients_crm_client_id_fkey";
            columns: ["crm_client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
        ];
      };
      client_members: {
        Row: Row<ClientMember>;
        Insert: Insert<ClientMember, "invited_by" | "created_at">;
        Update: Partial<ClientMember>;
        Relationships: [
          {
            foreignKeyName: "client_members_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_members_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      client_invites: {
        Row: Row<ClientInvite>;
        Insert: Insert<
          ClientInvite,
          | "id"
          | "invited_by"
          | "status"
          | "created_at"
          | "accepted_at"
          | "accepted_by"
        >;
        Update: Partial<ClientInvite>;
        Relationships: [
          {
            foreignKeyName: "client_invites_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_profiles: {
        Row: Row<BillingProfile>;
        Insert: Insert<
          BillingProfile,
          | "profile_type"
          | "currency"
          | "available_budget"
          | "billing_name"
          | "tax_id"
          | "address_line1"
          | "address_line2"
          | "address_city"
          | "address_postal_code"
          | "address_state"
          | "address_country"
          | "updated_at"
        >;
        Update: Partial<BillingProfile>;
        Relationships: [
          {
            foreignKeyName: "billing_profiles_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: true;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_accounts: {
        Row: Row<AdAccount>;
        Insert: Insert<
          AdAccount,
          | "id"
          | "google_ads_customer_id"
          | "status"
          | "reporting_role"
          | "currency"
          | "breakeven_roas"
          | "lifetime_ads_budget_usd"
          | "shopify_url"
          | "shopify_connected"
          | "shopify_client_id"
          | "shopify_scopes"
          | "color_dot"
          | "created_at"
          | "google_ads_refresh_token"
          | "google_ads_connected_email"
          | "google_ads_connected"
          | "commission_rate"
          | "list_commission_rate"
          | "shopify_admin_token"
          | "shopify_token_last4"
          | "shopify_connected_at"
          | "default_product_cost_pct"
          | "payment_fee_pct"
          | "payment_fee_fixed"
          | "shipping_cost_per_order"
          | "hst_shop_id"
          | "revenue_share_enabled"
        >;
        Update: Partial<AdAccount>;
        Relationships: [
          {
            foreignKeyName: "ad_accounts_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_account_commission_terms: {
        Row: Row<AdAccountCommissionTerm>;
        Insert: Insert<
          AdAccountCommissionTerm,
          "id" | "created_at" | "sealed_at"
        >;
        Update: Partial<AdAccountCommissionTerm>;
        Relationships: [
          {
            foreignKeyName: "ad_account_commission_terms_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_account_commission_terms_supersedes_id_fkey";
            columns: ["supersedes_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_commission_terms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_account_commission_terms_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      account_requests: {
        Row: Row<AccountRequest>;
        Insert: Insert<
          AccountRequest,
          | "id"
          | "google_ads_customer_id"
          | "store_name"
          | "shopify_collaborator_code"
          | "myshopify_url"
          | "status"
          | "created_at"
        >;
        Update: Partial<AccountRequest>;
        Relationships: [
          {
            foreignKeyName: "account_requests_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: Row<Campaign>;
        Insert: Insert<
          Campaign,
          | "id"
          | "status"
          | "spend"
          | "impressions"
          | "clicks"
          | "ctr"
          | "cpc"
          | "daily_budget"
          | "updated_at"
        >;
        Update: Partial<Campaign>;
        Relationships: [
          {
            foreignKeyName: "campaigns_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_action_policies: {
        Row: Row<CampaignActionPolicy>;
        Insert: Insert<
          CampaignActionPolicy,
          | "supersedes_policy_id"
          | "executor"
          | "allowed_actions"
          | "max_daily_budget_micros"
          | "created_at"
        >;
        Update: Partial<CampaignActionPolicy>;
        Relationships: [
          {
            foreignKeyName: "campaign_action_policies_client_reporting_binding_id_fkey";
            columns: ["client_reporting_binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_policies_supersedes_policy_id_fkey";
            columns: ["supersedes_policy_id"];
            isOneToOne: true;
            referencedRelation: "campaign_action_policies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_policies_configured_by_fkey";
            columns: ["configured_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_action_operations: {
        Row: Row<CampaignActionOperation>;
        Insert: Insert<
          CampaignActionOperation,
          | "shopify_anchor_binding_id"
          | "shopify_anchor_ad_account_id"
          | "executor"
          | "status"
          | "previous_status"
          | "next_status"
          | "previous_daily_budget_micros"
          | "next_daily_budget_micros"
          | "requested_details"
          | "requested_at"
          | "observed_status"
          | "observed_daily_budget_micros"
          | "result_details"
          | "completed_at"
        >;
        Update: Partial<CampaignActionOperation>;
        Relationships: [
          {
            foreignKeyName: "campaign_action_operations_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_client_reporting_binding_id_fkey";
            columns: ["client_reporting_binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_client_google_ads_connection_id_fkey";
            columns: ["client_google_ads_connection_id"];
            isOneToOne: false;
            referencedRelation: "client_google_ads_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_shopify_anchor_binding_id_fkey";
            columns: ["shopify_anchor_binding_id"];
            isOneToOne: false;
            referencedRelation: "client_reporting_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_shopify_anchor_ad_account_id_fkey";
            columns: ["shopify_anchor_ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_billing_start_id_fkey";
            columns: ["billing_start_id"];
            isOneToOne: false;
            referencedRelation: "ad_account_billing_starts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_action_operations_policy_reference_fkey";
            columns: [
              "campaign_action_policy_id",
              "client_reporting_binding_id",
              "policy_revision",
            ];
            isOneToOne: false;
            referencedRelation: "campaign_action_policies";
            referencedColumns: [
              "id",
              "client_reporting_binding_id",
              "revision",
            ];
          },
          {
            foreignKeyName: "campaign_action_operations_requested_by_fkey";
            columns: ["requested_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      store_products: {
        Row: Row<StoreProduct>;
        Insert: Insert<
          StoreProduct,
          "id" | "price" | "currency" | "source" | "last_seen" | "created_at"
        >;
        Update: Partial<StoreProduct>;
        Relationships: [
          {
            foreignKeyName: "store_products_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      client_hst_credentials: {
        Row: Row<ClientHstCredentials>;
        Insert: Insert<
          ClientHstCredentials,
          | "access_token_enc"
          | "refresh_token_enc"
          | "token_expires_at"
          | "last_error"
          | "connected_at"
          | "updated_at"
          | "shops"
        >;
        Update: Partial<ClientHstCredentials>;
        Relationships: [];
      };
      hst_order_charges: {
        Row: Row<HstOrderCharge>;
        Insert: Insert<
          HstOrderCharge,
          "order_day" | "paid_at" | "tariff" | "our_cost" | "currency" | "synced_at"
        >;
        Update: Partial<HstOrderCharge>;
        Relationships: [];
      };
      product_costs: {
        Row: Row<ProductCost>;
        Insert: Insert<
          ProductCost,
          "id" | "currency" | "effective_from" | "created_at" | "source"
        >;
        Update: Partial<ProductCost>;
        Relationships: [
          {
            foreignKeyName: "product_costs_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "store_products";
            referencedColumns: ["id"];
          },
        ];
      };
      product_cost_tiers: {
        Row: Row<ProductCostTier>;
        Insert: Insert<ProductCostTier, "id">;
        Update: Partial<ProductCostTier>;
        Relationships: [
          {
            foreignKeyName: "product_cost_tiers_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "store_products";
            referencedColumns: ["id"];
          },
        ];
      };
      cogs_collections: {
        Row: Row<CogsCollectionRow>;
        Insert: Insert<CogsCollectionRow, "id" | "created_at">;
        Update: Partial<CogsCollectionRow>;
        Relationships: [
          {
            foreignKeyName: "cogs_collections_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      cogs_collection_members: {
        Row: Row<CogsCollectionMember>;
        Insert: Row<CogsCollectionMember>;
        Update: Partial<CogsCollectionMember>;
        Relationships: [
          {
            foreignKeyName: "cogs_collection_members_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "cogs_collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cogs_collection_members_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: true;
            referencedRelation: "store_products";
            referencedColumns: ["id"];
          },
        ];
      };
      cogs_collection_tiers: {
        Row: Row<CogsCollectionTier>;
        Insert: Insert<CogsCollectionTier, "id">;
        Update: Partial<CogsCollectionTier>;
        Relationships: [
          {
            foreignKeyName: "cogs_collection_tiers_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "cogs_collections";
            referencedColumns: ["id"];
          },
        ];
      };
      daily_metrics: {
        Row: Row<DailyMetric>;
        Insert: Insert<
          DailyMetric,
          | "ad_spend"
          | "impressions"
          | "clicks"
          | "conversions"
          | "conversion_value"
          | "revenue"
          | "orders_count"
          | "units_sold"
          | "attributed_orders"
          | "attributed_revenue"
          | "refunds_amount"
          | "product_cost"
          | "payment_fees"
          | "shipping_cost"
          | "revenue_share_base"
          | "revenue_share_amount"
          | "computed_at"
          | "revenue_store"
          | "refunds_store"
          | "attributed_revenue_store"
          | "store_currency"
        >;
        Update: Partial<DailyMetric>;
        Relationships: [
          {
            foreignKeyName: "daily_metrics_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      hst_integration: {
        Row: Row<HstIntegration>;
        Insert: Insert<
          HstIntegration,
          | "id"
          | "access_token"
          | "refresh_token"
          | "token_expires_at"
          | "username_enc"
          | "password_enc"
          | "last_synced_at"
          | "last_attempt_at"
          | "last_error"
          | "updated_at"
        >;
        Update: Partial<HstIntegration>;
        Relationships: [];
      };
      hst_payments: {
        Row: Row<HstPayment>;
        Insert: Insert<
          HstPayment,
          "id" | "paid_on" | "notes" | "created_by" | "created_at"
        >;
        Update: Partial<HstPayment>;
        Relationships: [];
      };
      creative_submissions: {
        Row: Row<CreativeSubmission>;
        Insert: Insert<
          CreativeSubmission,
          | "id"
          | "submitted_by"
          | "collection_url"
          | "notes"
          | "status"
          | "review_notes"
          | "reviewed_at"
          | "reviewed_by"
          | "created_at"
        >;
        Update: Partial<CreativeSubmission>;
        Relationships: [
          {
            foreignKeyName: "creative_submissions_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "creative_submissions_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      creative_deliveries: {
        Row: Row<CreativeDelivery>;
        Insert: Insert<
          CreativeDelivery,
          | "id"
          | "status"
          | "file_count"
          | "size_mb"
          | "thumbnail_urls"
          | "created_at"
        >;
        Update: Partial<CreativeDelivery>;
        Relationships: [
          {
            foreignKeyName: "creative_deliveries_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      set_campaign_action_policy: {
        Args: {
          p_policy_id: string;
          p_idempotency_key: string;
          p_client_reporting_binding_id: string;
          p_expected_policy_id: string | null;
          p_allowed_actions: CampaignActionPolicyAction[];
          p_max_daily_budget_micros: number | string | null;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: CampaignActionPolicy;
      };
      start_campaign_action: {
        Args: {
          p_operation_id: string;
          p_idempotency_key: string;
          p_execution_claim_id: string;
          p_client_id: string;
          p_client_reporting_binding_id: string;
          p_ad_account_id: string;
          p_client_google_ads_connection_id: string;
          p_google_ads_customer_id: string;
          p_provider_campaign_id: string;
          p_campaign_name: string;
          p_action: Exclude<CampaignAction, "campaign_launched">;
          p_currency: string;
          p_actor_id: string;
          p_previous_status?: "active" | "paused" | null;
          p_next_status?: "active" | "paused" | null;
          p_previous_daily_budget_micros?: number | string | null;
          p_next_daily_budget_micros?: number | string | null;
          p_details?: Json;
        };
        Returns: CampaignActionOperation;
      };
      complete_campaign_action: {
        Args: {
          p_operation_id: string;
          p_idempotency_key: string;
          p_execution_claim_id: string;
          p_actor_id: string;
          p_outcome: Exclude<CampaignActionOperationStatus, "requested">;
          p_observed_status?: "active" | "paused" | "ended" | null;
          p_observed_daily_budget_micros?: number | string | null;
          p_details?: Json;
        };
        Returns: CampaignActionOperation;
      };
      update_portal_client_identity: {
        Args: {
          p_client_id: string;
          p_full_name: string;
          p_email: string;
          p_discord_handle: string | null;
          p_admin_id: string;
        };
        Returns: string;
      };
      archive_portal_client: {
        Args: { p_client_id: string; p_admin_id: string };
        Returns: string;
      };
      map_client_google_ads_to_store: {
        Args: {
          p_google_ads_connection_id: string;
          p_shopify_connection_id: string;
          p_admin_id: string;
        };
        Returns: string;
      };
      set_client_google_ads_admin_label: {
        Args: { p_connection_id: string; p_label: string | null; p_admin_id: string };
        Returns: string;
      };
      set_portal_client_access_block: {
        Args: { p_client_id: string; p_admin_id: string; p_blocked: boolean };
        Returns: string;
      };
      delete_portal_client_completely: {
        Args: { p_client_id: string; p_admin_id: string };
        Returns: string;
      };
      disconnect_legacy_shopify_connection: {
        Args: { p_account_id: string; p_admin_id: string };
        Returns: string;
      };
      commit_client_reporting_binding: {
        Args: {
          p_ad_account_id: string;
          p_shopify_connection_id: string | null;
          p_google_ads_connection_id: string | null;
          p_shopify_anchor_binding_id: string | null;
          p_idempotency_key: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      revoke_client_reporting_binding: {
        Args: {
          p_binding_id: string;
          p_admin_id: string;
          p_idempotency_key: string;
          p_reason: string;
        };
        Returns: string;
      };
      provision_client_reporting_anchor: {
        Args: {
          p_shopify_connection_id: string | null;
          p_google_ads_connection_id: string | null;
          p_shopify_anchor_binding_id: string | null;
          p_existing_ad_account_id: string | null;
          p_idempotency_key: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      stage_client_reporting_source: {
        Args: {
          p_client_id: string;
          p_shopify_connection_id: string | null;
          p_google_ads_connection_id: string | null;
          p_shopify_anchor_binding_id: string | null;
          p_existing_ad_account_id: string | null;
          p_idempotency_key: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      commit_client_staged_reporting_metrics: {
        Args: {
          p_binding_id: string;
          p_success_from: string;
          p_success_to: string;
          p_rows: Json;
        };
        Returns: string;
      };
      record_client_staged_reporting_sync_success: {
        Args: {
          p_binding_id: string;
          p_source_type: ClientReportingSyncSource;
          p_success_from: string;
          p_success_to: string;
          p_source_currency: string;
          p_row_count: number;
        };
        Returns: string;
      };
      promote_client_reporting_source: {
        Args: {
          p_binding_id: string;
          p_admin_id: string;
          p_idempotency_key: string;
          p_reason: string;
        };
        Returns: string;
      };
      abandon_client_reporting_source: {
        Args: {
          p_binding_id: string;
          p_admin_id: string;
          p_idempotency_key: string;
          p_reason: string;
        };
        Returns: string;
      };
      upgrade_client_reporting_google_binding_to_pair: {
        Args: {
          p_binding_id: string;
          p_shopify_connection_id: string;
          p_reconnect_session_id: string;
          p_idempotency_key: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      record_client_reporting_sync_success: {
        Args: {
          p_binding_id: string;
          p_source_type: ClientReportingSyncSource;
          p_success_from: string;
          p_success_to: string;
          p_source_currency: string;
          p_row_count: number;
        };
        Returns: string;
      };
      claim_admin_reporting_snapshot_refresh: {
        Args: {
          p_family: AdminReportingSnapshotFamily;
          p_scope_account_id: string;
          p_from_day: string;
          p_to_day: string;
          p_authority_key: string;
          p_authority_manifest: Json;
          p_lease_seconds?: number;
        };
        Returns: string | null;
      };
      complete_admin_reporting_snapshot_refresh: {
        Args: {
          p_family: AdminReportingSnapshotFamily;
          p_scope_account_id: string;
          p_from_day: string;
          p_to_day: string;
          p_authority_key: string;
          p_lease_token: string;
          p_state: "ready" | "partial" | "empty" | "unavailable";
          p_payload: Json;
          p_message?: string | null;
        };
        Returns: boolean;
      };
      fail_admin_reporting_snapshot_refresh: {
        Args: {
          p_family: AdminReportingSnapshotFamily;
          p_scope_account_id: string;
          p_from_day: string;
          p_to_day: string;
          p_authority_key: string;
          p_lease_token: string;
          p_error_code: string;
        };
        Returns: boolean;
      };
      record_client_google_ads_reporting_identity: {
        Args: {
          p_connection_id: string;
          p_currency: string;
          p_time_zone: string;
          p_admin_id: string;
          p_verified_at: string;
        };
        Returns: string;
      };
      enrich_client_google_ads_reporting_metadata: {
        Args: {
          p_connection_id: string;
          p_currency: string;
          p_time_zone: string;
          p_admin_id: string;
          p_verified_at: string;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: string;
      };
      activate_client_reporting_cutover: {
        Args: {
          p_client_id: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      rollback_client_reporting_cutover: {
        Args: {
          p_client_id: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      reactivate_client_reporting_cutover: {
        Args: {
          p_client_id: string;
          p_admin_id: string;
          p_reason: string;
        };
        Returns: string;
      };
      create_client_onboarding_invitation: {
        Args: {
          p_session_id: string;
          p_mode: ClientOnboardingMode;
          p_requested_assets: ClientOnboardingAsset[];
          p_target_client_id: string | null;
          p_token_hash: string;
          p_expires_at: string;
          p_created_by: string;
        };
        Returns: string;
      };
      create_client_shopify_reconnect_invitation: {
        Args: {
          p_session_id: string;
          p_target_source: ClientShopifyReconnectTargetSource;
          p_target_id: string;
          p_token_hash: string;
          p_expires_at: string;
          p_created_by: string;
        };
        Returns: string;
      };
      legacy_asset_writes_allowed: {
        Args: { p_client_id: string };
        Returns: boolean;
      };
      rotate_client_onboarding_invitation: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_expires_at: string;
          p_admin_id: string;
        };
        Returns: string;
      };
      claim_client_onboarding_identity: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_user_id: string;
          p_first_name: string;
          p_last_name: string;
          p_email: string;
          p_discord_handle: string | null;
        };
        Returns: string;
      };
      store_client_windsor_authorization: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_ciphertext: string;
        };
        Returns: string;
      };
      complete_client_shopify_connection: {
        Args: {
          p_connection_id: string;
          p_session_id: string;
          p_token_hash: string;
          p_shopify_shop_id: string;
          p_shopify_name: string;
          p_shopify_domain: string;
          p_primary_domain: string | null;
          p_shopify_currency: string;
          p_shopify_client_id: string;
          p_credential_hint: string;
          p_granted_scopes: string[];
          p_client_secret_ciphertext: string;
        };
        Returns: string;
      };
      record_client_shopify_health: {
        Args: {
          p_connection_id: string;
          p_admin_id: string;
          p_ok: boolean;
          p_tested_at: string;
          p_error_code: string | null;
        };
        Returns: string;
      };
      revoke_client_shopify_connection: {
        Args: { p_connection_id: string; p_admin_id: string };
        Returns: string;
      };
      upsert_client_google_ads_connection: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_windsor_account_id: string;
          p_account_name: string;
          p_currency: string | null;
          p_time_zone: string | null;
          p_data_source_id: string | null;
        };
        Returns: string;
      };
      upsert_client_google_ads_connections: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_accounts: Array<{
            windsorAccountId: string;
            accountName: string;
            currency: string | null;
            timeZone: string | null;
            dataSourceId: string | null;
          }>;
        };
        Returns: string[];
      };
      record_client_google_ads_health: {
        Args: {
          p_connection_id: string;
          p_admin_id: string;
          p_ok: boolean;
          p_tested_at: string;
          p_error_code: string | null;
        };
        Returns: string;
      };
      revoke_client_google_ads_connection: {
        Args: { p_connection_id: string; p_admin_id: string };
        Returns: string;
      };
      replace_client_asset_mappings: {
        Args: {
          p_session_id: string;
          p_token_hash: string;
          p_mappings: Array<{
            shopifyConnectionId: string;
            googleAdsConnectionId: string;
          }>;
        };
        Returns: number;
      };
      submit_client_onboarding_session: {
        Args: { p_session_id: string; p_token_hash: string };
        Returns: string;
      };
      review_client_onboarding_session: {
        Args: {
          p_session_id: string;
          p_admin_id: string;
          p_activate?: boolean;
        };
        Returns: string;
      };
      revoke_client_onboarding_session: {
        Args: { p_session_id: string; p_admin_id: string };
        Returns: string;
      };
      create_audit_shopify_invitation: {
        Args: {
          p_connection_id: string;
          p_store_label: string;
          p_token_hash: string;
          p_expires_at: string;
          p_created_by: string;
        };
        Returns: string;
      };
      complete_audit_shopify_connection: {
        Args: {
          p_connection_id: string;
          p_token_hash: string;
          p_shopify_shop_id: string;
          p_shopify_name: string;
          p_shopify_domain: string;
          p_primary_domain: string | null;
          p_shopify_currency: string;
          p_shopify_client_id: string;
          p_credential_hint: string;
          p_granted_scopes: string[];
          p_client_secret_ciphertext: string;
        };
        Returns: string;
      };
      rotate_audit_shopify_invitation: {
        Args: {
          p_connection_id: string;
          p_token_hash: string;
          p_expires_at: string;
          p_admin_id: string;
        };
        Returns: string;
      };
      record_audit_shopify_invitation_failure: {
        Args: {
          p_connection_id: string;
          p_token_hash: string;
          p_error_code: string;
        };
        Returns: number | null;
      };
      revoke_audit_shopify_connection: {
        Args: { p_connection_id: string; p_admin_id: string };
        Returns: string;
      };
      review_audit_shopify_connection: {
        Args: { p_connection_id: string; p_admin_id: string };
        Returns: string;
      };
      enqueue_audit_shopify_run: {
        Args: {
          p_run_id: string;
          p_connection_id: string;
          p_requested_by: string;
          p_shopify_domain: string;
          p_requested_source: string;
          p_requested_note: string | null;
          p_schema_hash: string;
          p_manifest_hash: string;
          p_max_retries?: number;
          p_checkpoint?: Record<string, unknown>;
          p_actor_type?: AuditShopifyRunRequestActor;
        };
        Returns: string;
      };
      claim_audit_shopify_run: {
        Args: {
          p_lease_token: string;
          p_run_id?: string | null;
          p_shopify_domain?: string | null;
          p_lease_seconds?: number;
        };
        Returns: AuditShopifyRun[];
      };
      renew_audit_shopify_run: {
        Args: {
          p_run_id: string;
          p_shopify_domain: string;
          p_lease_token: string;
          p_lease_generation: number;
          p_checkpoint: Record<string, unknown>;
          p_lease_seconds?: number;
        };
        Returns: AuditShopifyRun[];
      };
      yield_audit_shopify_run: {
        Args: {
          p_run_id: string;
          p_shopify_domain: string;
          p_lease_token: string;
          p_lease_generation: number;
          p_checkpoint: Record<string, unknown>;
          p_continue_after_seconds?: number;
        };
        Returns: AuditShopifyRun[];
      };
      complete_audit_shopify_run: {
        Args: {
          p_run_id: string;
          p_shopify_domain: string;
          p_lease_token: string;
          p_lease_generation: number;
          p_checkpoint: Record<string, unknown>;
          p_artifact: Record<string, unknown>;
        };
        Returns: AuditShopifyRun[];
      };
      fail_audit_shopify_run: {
        Args: {
          p_run_id: string;
          p_shopify_domain: string;
          p_lease_token: string;
          p_lease_generation: number;
          p_checkpoint: Record<string, unknown>;
          p_error_code: string;
          p_retryable: boolean;
          p_retry_after_seconds?: number;
        };
        Returns: AuditShopifyRun[];
      };
      is_admin: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      move_card: {
        Args: { p_card_id: string; p_column_id: string; p_position: number };
        Returns: undefined;
      };
      owns_ad_account: {
        Args: { p_ad_account_id: string };
        Returns: boolean;
      };
      owns_store_product: {
        Args: { p_product_id: string };
        Returns: boolean;
      };
      owns_cogs_collection: {
        Args: { p_collection_id: string };
        Returns: boolean;
      };
      /** Creates the caller's pending portal_clients row (migration 0004). */
      claim_portal_client: {
        Args: Record<string, never>;
        Returns: string;
      };
      /** Owner or sócio of that workspace (migration 0015). */
      is_client_member: {
        Args: { p_client_id: string };
        Returns: boolean;
      };
      /** Turns every pending invite for the caller's confirmed email into a
       *  membership. Idempotent; returns how many it accepted (migration 0015). */
      accept_client_invites: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** Acquire the only active Stripe-issue generation for one client (0032). */
      acquire_billing_issue_lease: {
        Args: {
          p_client_id: string;
          p_lease_token: string;
          p_period_start: string;
          p_issued_by: string | null;
        };
        Returns: BillingIssueLease[];
      };
      /** Heartbeat and fence-check one active Stripe-issue generation (0032). */
      renew_billing_issue_lease: {
        Args: {
          p_client_id: string;
          p_lease_token: string;
          p_fencing_token: number;
        };
        Returns: BillingIssueLease[];
      };
      /** Release only the still-current Stripe-issue generation (0032). */
      release_billing_issue_lease: {
        Args: {
          p_client_id: string;
          p_lease_token: string;
          p_fencing_token: number;
        };
        Returns: boolean;
      };
      /** Record an issue error only while the exact fence is still current (0032). */
      record_billing_issue_error: {
        Args: {
          p_client_id: string;
          p_lease_token: string;
          p_fencing_token: number;
          p_invoice_id: string;
          p_issue_error: string;
        };
        Returns: boolean;
      };
      begin_billing_automation_run: {
        Args: { p_issuance_enabled: boolean };
        Returns: BillingAutomationRun[];
      };
      seed_billing_automation_items: {
        Args: { p_run_id: string; p_closed_through: string };
        Returns: number;
      };
      claim_billing_automation_items: {
        Args: { p_run_id: string; p_limit?: number };
        Returns: BillingAutomationItem[];
      };
      claim_expired_skipped_billing_automation_items: {
        Args: { p_run_id: string; p_limit?: number };
        Returns: BillingAutomationItem[];
      };
      set_app_secret: {
        Args: {
          p_key: string;
          p_ciphertext: string;
          p_hint: string | null;
          p_updated_by: string;
        };
        Returns: string;
      };
      skip_billing_cycle: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_period_end: string;
          p_reason: string | null;
          p_created_by: string;
        };
        Returns: BillingCycleSkip[];
      };
      remove_billing_cycle_skip: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_removed_by: string;
        };
        Returns: boolean;
      };
      record_billing_automation_item_result: {
        Args: {
          p_item_id: string;
          p_run_id: string;
          p_claim_version: number;
          p_state: Extract<
            BillingAutomationItemState,
            "blocked" | "issued" | "no_charge"
          >;
          p_stage: Exclude<BillingAutomationItemStage, "discovered">;
          p_code?: string | null;
          p_invoice_id?: string | null;
          p_amount?: number | null;
          p_billable_spend?: number | null;
          p_evidence_account_count?: number;
        };
        Returns: BillingAutomationItem[];
      };
      finish_billing_automation_run: {
        Args: {
          p_run_id: string;
          p_status: Exclude<BillingAutomationRunStatus, "running">;
          p_historical_rollovers_checked: number;
          p_exact_refresh_requested: number;
          p_exact_refresh_completed: number;
          p_reconciliation_checked: number;
          p_reconciliation_updated: number;
          p_error_count: number;
        };
        Returns: BillingAutomationRun[];
      };
      manual_invoice_authoritative_rows: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_period_end: string;
        };
        Returns: {
          account_id: string;
          billable_gross_micros: string | number;
        }[];
      };
      /** Atomically creates one manual invoice and consumes its Google ledger rows (0028). */
      create_manual_invoice: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_period_end: string;
          p_amount: number;
          p_line_items: InvoiceLine[];
          p_ledger_rows: {
            commission_id: string;
            gross_amount: number | string;
            currency: string;
          }[];
          p_issued_by: string;
          p_calculation_version: string;
        };
        Returns: Invoice[];
      };
      /** V3 issue/waive transaction with a sealed manual-referral term (0030). */
      create_manual_referral_invoice: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_period_end: string;
          p_amount: number;
          p_line_items: InvoiceLine[];
          p_ledger_rows: {
            commission_id: string;
            gross_amount: number | string;
            currency: string;
          }[];
          p_billing_recipient: BillingRecipientSnapshot;
          p_referral_term_id: string | null;
          p_issued_by: string | null;
          p_calculation_version: string;
        };
        Returns: Invoice[];
      };
      /** Fill one empty referral attribution after a verified admin review (0031). */
      assign_manual_referral_attribution: {
        Args: {
          p_referred_client_id: string;
          p_referrer_client_id: string;
          p_decision_id: string;
          p_reason: string;
          p_reviewed_by: string;
        };
        Returns: ReferralAttributionEvent[];
      };
      /** Service-only append of one CAS-protected referral grant/revoke decision. */
      schedule_manual_referral_discount: {
        Args: {
          p_client_id: string;
          p_referred_client_id: string;
          p_action: ReferralDiscountAction;
          p_effective_from: string;
          p_expected_term_id: string | null;
          p_decision_id: string;
          p_reason: string;
          p_reviewed_by: string;
        };
        Returns: ReferralDiscountTerm[];
      };
      /** Authenticated-admin CAS scheduler for one Monday-effective store rate. */
      schedule_ad_account_commission_rate: {
        Args: {
          p_account_id: string;
          p_list_rate: number;
          p_expected_term_id: string | null;
          p_decision_id: string;
        };
        Returns: AdAccountCommissionTerm[];
      };
      /** Resolve a store's exact list-rate term for one Monday billing week. */
      resolve_ad_account_commission_term: {
        Args: { p_ad_account_id: string; p_period_start: string };
        Returns: {
          term_id: string | null;
          effective_from: string | null;
          revision: number;
          list_rate: number | string;
        }[];
      };
      /** Resolve the exact term in force for one client's Monday billing week. */
      resolve_manual_referral_term: {
        Args: { p_client_id: string; p_period_start: string };
        Returns: {
          term_id: string | null;
          effective_from: string | null;
          revision: number;
          list_rate: number | string;
          referral_step_rate: number | string;
          referral_count: number;
          referral_discount_rate: number | string;
          fee_rate: number | string;
        }[];
      };
      /**
       * Portal-safe historical fee timeline. The authenticated RPC returns no
       * term ids, people, evidence, review metadata or reasons.
       */
      manual_referral_rate_schedule: {
        Args: { p_client_id: string };
        Returns: {
          effective_from: string;
          revision: number;
          referral_count: number;
          referral_discount_rate: number | string;
          fee_rate: number | string;
        }[];
      };
      /**
       * Service-only commit of an authoritative Google opening counter. It
       * either activates an existing account or provisions a pending Google
       * request, with the baseline and status change in one transaction.
       */
      commit_google_ads_billing_start: {
        Args: {
          p_account_id: string | null;
          p_request_id: string | null;
          p_capture_id: string;
          p_google_ads_customer_id: string;
          p_google_local_date: string;
          p_google_time_zone: string;
          p_currency: string;
          p_baseline_cost_micros: string;
          p_capture_started_at: string;
          p_captured_at: string;
          p_source: string;
          p_reviewed_by: string;
        };
        Returns: AdAccount[];
      };
      /** Service-only commit of the reviewed pre-v3 full-entry-day boundary. */
      commit_reviewed_full_day_billing_start: {
        Args: {
          p_account_id: string;
          p_metadata_capture_id: string;
          p_google_ads_customer_id: string;
          p_google_local_date: string;
          p_google_time_zone: string;
          p_currency: string;
          p_metadata_capture_started_at: string;
          p_metadata_captured_at: string;
          p_metadata_authority: string;
          p_metadata_contract: string;
        };
        Returns: AdAccountBillingStart[];
      };
      /** Service-only commit of an authoritative Google closing counter. */
      commit_google_ads_billing_end: {
        Args: {
          p_account_id: string;
          p_capture_id: string;
          p_google_ads_customer_id: string;
          p_google_local_date: string;
          p_google_time_zone: string;
          p_currency: string;
          p_end_cost_micros: string;
          p_capture_started_at: string;
          p_captured_at: string;
          p_source: string;
          p_reviewed_by: string;
        };
        Returns: AdAccountBillingEnd[];
      };
      /**
       * Appends one pending referral-code signal without changing referred_by.
       * 'ok' also covers an exact retry; 'claim_pending' means a different
       * immutable first claim already exists. The RPC never returns a client
       * identity, and only the reviewed admin attribution RPC seals the link.
       */
      claim_referral_code: {
        Args: { p_code: string };
        Returns: string;
      };
      /** Refreshes the current display cache from Monday-effective manual terms. */
      refresh_all_referral_rates: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** Manual portal state; names and statuses only, never referral evidence. */
      referral_summary: {
        Args: { p_client_id: string };
        Returns: { name: string; status: string }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
