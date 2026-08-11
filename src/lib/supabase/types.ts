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
  avatar_url: string | null;
  crm_client_id: string | null;
  approval_status: ClientApprovalStatus;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
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
export type InvoiceLineKind = "spend" | "fee" | "rev_share";

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
  /** Percentage the line was computed at — blended over the week. Spend: null. */
  rate?: number | null;
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
  /** Which immutable commercial boundary authorised the billing start. */
  billingStartBasis?: "observed_google_counter" | "reviewed_full_day";
  /** Immutable billing-start record that authorised this line. */
  billingStartId?: string;
  /** Google-local day on which billing started for this store. */
  billingStartDate?: string;
  /** UTC instant at which the opening Google counter was captured; observed starts only. */
  billingStartedAt?: string;
  /** IANA timezone used by the opening boundary. */
  billingTimeZone?: string;
  /** Immutable account-level proof for a reviewed full-entry-day start. */
  reviewedFullDayBoundaryId?: string;
  /** Global policy version that authorised a reviewed full-day start. */
  billingPolicyVersion?: string;
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
  /** Historical rollover provenance; never presented as a live Google capture. */
  entryDate?: string;
  entryTimeZone?: string;
  entryDayTreatment?: "full-day-inclusive";
  periodStart?: string;
  periodEnd?: string;
  adSpendPassThroughAmount?: number;
  revenueShareAmount?: number;
  referralDiscountAmount?: number;
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
  /** Null only for the CRON_SECRET-protected automatic issuer. */
  issued_by: string | null;
  issuer_kind: "admin" | "automation";
  acquired_at: string;
  renewed_at: string;
  lease_expires_at: string;
  released_at: string | null;
};

export type BillingAutomationRunStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "failed";

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
  | "pending"
  | "processing"
  | "blocked"
  | "issued"
  | "no_charge";

export type BillingAutomationItemStage =
  | "discovered"
  | "preview"
  | "google_evidence"
  | "stripe_issue"
  | "complete";

/** One fenced, retryable client/week work receipt (0036). */
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
  updated_at: string;
};

export type HistoricalBillingRollover = {
  id: string;
  client_id: string;
  period_start: string;
  period_end: string;
  calculation_version: string;
  currency: string;
  fee_rate: number | string;
  ad_spend_pass_through_rate: number | string;
  revenue_share_rate: number | string;
  referral_discount_rate: number | string;
  source_gross_amount: number | string;
  amount: number | string;
  line_items: InvoiceLine[];
  source_row_count: number;
  account_count: number;
  legacy_invoice_ids: string[];
  source_fingerprint: string;
  snapshot_created_at: string;
  snapshot_created_by: string;
};

export type HistoricalBillingRolloverRow = {
  rollover_id: string;
  commission_id: string;
  ad_account_id: string;
  store_name: string;
  account_created_at: string;
  entry_day: string;
  occurred_on: string;
  source_gross_amount: number | string;
  billable_gross_amount: number | string;
  currency: string;
  source_snapshot: Record<string, unknown>;
  created_at: string;
};

export type HistoricalBillingRolloverIssuance = {
  rollover_id: string;
  invoice_id: string;
  issuer_kind: "automation";
  calculation_version: string;
  billing_recipient: BillingRecipientSnapshot;
  created_at: string;
};

export type HistoricalBillingRolloverReview = Omit<
  HistoricalBillingRollover,
  "id"
> & {
  rollover_id: string;
  invoice_id: string | null;
  invoice_status: InvoiceStatus | null;
  invoice_issued_at: string | null;
  invoice_issue_error: string | null;
  issuer_kind: "automation" | null;
  invoice_created_at: string | null;
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
  /** Explicit human/system provenance for reviewed billing contracts. */
  issuer_kind: "admin" | "automation" | null;
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

export type BillingStartBasis =
  | "observed_google_counter"
  | "reviewed_full_day";

/**
 * Immutable financial start. Only the observed branch carries Google capture
 * fields; reviewed_full_day references a separate policy proof instead.
 */
export type AdAccountBillingStart = {
  id: string;
  ad_account_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: string;
  /** Integer micros for an observed start; null for reviewed_full_day. */
  baseline_cost_micros: number | string | null;
  capture_started_at: string | null;
  captured_at: string | null;
  capture_id: string | null;
  source: "agency" | null;
  reviewed_by: string | null;
  start_basis: BillingStartBasis;
  reviewed_full_day_boundary_id: string | null;
  created_at: string;
};

/**
 * Immutable account-level proof for the reviewed pre-v3 policy. Commercial
 * entry follows Lisbon; Google ledger dates follow the account's real zone.
 */
export type ReviewedFullDayBillingBoundary = {
  id: string;
  ad_account_id: string;
  client_id: string;
  google_ads_customer_id: string;
  account_created_at: string;
  entry_day: string;
  entry_time_zone: "Europe/Lisbon";
  google_local_date: string;
  google_time_zone: string;
  entry_day_treatment: "full-day-inclusive";
  currency: "EUR";
  cutover_monday: "2026-08-03";
  policy_version:
    "agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2";
  metadata_capture_id: string;
  metadata_capture_started_at: string;
  metadata_captured_at: string;
  metadata_authority: "client_oauth";
  metadata_contract: "google-customer-metadata-v1";
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
  // Agency revenue share (migration 0010); admin-only via the same guard.
  // Rate is not stored here — it lives in the Google Ads campaign name.
  revenue_share_enabled: boolean;
  /**
   * Tracked collection revenue share, percent. Positive opts the account into
   * metrics/finance tracking only — unlike `revenue_share_enabled`, it never
   * blocks automatic weekly fee billing.
   */
  revenue_share_rate: string | number;
};

export type BillingCycleSkip = {
  id: string;
  client_id: string;
  period_start: string;
  period_end: string;
  reason: string | null;
  created_by: string;
  created_at: string;
};

export type AppSecret = {
  key: string;
  ciphertext: string;
  hint: string | null;
  updated_by: string | null;
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
  scope_profile: "store-audit-full-v1";
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
    | "verification_failed";
  actor_type: "admin" | "invite" | "system";
  actor_profile_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
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
};

// HST supplier-commission integration (migration 0011). Single-row config.
export type HstIntegration = {
  id: boolean;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
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
  created_at: string;
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
          | "issuer_kind"
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
      app_secrets: {
        Row: Row<AppSecret>;
        Insert: Insert<AppSecret, "hint" | "updated_by" | "updated_at">;
        Update: Partial<Insert<AppSecret, "hint" | "updated_by" | "updated_at">>;
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
      billing_cycle_skips: {
        Row: Row<BillingCycleSkip>;
        Insert: Insert<BillingCycleSkip, "id" | "reason" | "created_at">;
        Update: Partial<Insert<BillingCycleSkip, "id" | "reason" | "created_at">>;
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
      historical_billing_rollovers: {
        Row: Row<HistoricalBillingRollover>;
        Insert: Insert<
          HistoricalBillingRollover,
          "id" | "legacy_invoice_ids" | "snapshot_created_at" | "snapshot_created_by"
        >;
        Update: Partial<HistoricalBillingRollover>;
        Relationships: [
          {
            foreignKeyName: "historical_billing_rollovers_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "portal_clients";
            referencedColumns: ["id"];
          },
        ];
      };
      historical_billing_rollover_rows: {
        Row: Row<HistoricalBillingRolloverRow>;
        Insert: Insert<HistoricalBillingRolloverRow, "created_at">;
        Update: Partial<HistoricalBillingRolloverRow>;
        Relationships: [
          {
            foreignKeyName: "historical_billing_rollover_rows_rollover_id_fkey";
            columns: ["rollover_id"];
            isOneToOne: false;
            referencedRelation: "historical_billing_rollovers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "historical_billing_rollover_rows_commission_id_fkey";
            columns: ["commission_id"];
            isOneToOne: true;
            referencedRelation: "commissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "historical_billing_rollover_rows_ad_account_id_fkey";
            columns: ["ad_account_id"];
            isOneToOne: false;
            referencedRelation: "ad_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      historical_billing_rollover_issuances: {
        Row: Row<HistoricalBillingRolloverIssuance>;
        Insert: Insert<
          HistoricalBillingRolloverIssuance,
          "issuer_kind" | "created_at"
        >;
        Update: Partial<HistoricalBillingRolloverIssuance>;
        Relationships: [
          {
            foreignKeyName: "historical_billing_rollover_issuances_rollover_id_fkey";
            columns: ["rollover_id"];
            isOneToOne: true;
            referencedRelation: "historical_billing_rollovers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "historical_billing_rollover_issuances_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: true;
            referencedRelation: "invoices";
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
        Insert: Insert<
          ManualReferralBillingConfig,
          "singleton" | "created_at"
        >;
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
        Insert: Insert<
          AdAccountBillingStart,
          "id" | "start_basis" | "reviewed_full_day_boundary_id" | "created_at"
        >;
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
          {
            foreignKeyName: "ad_account_billing_starts_reviewed_boundary_fkey";
            columns: [
              "reviewed_full_day_boundary_id",
              "ad_account_id",
              "google_ads_customer_id",
              "google_local_date",
              "google_time_zone",
              "currency",
            ];
            isOneToOne: true;
            referencedRelation: "reviewed_full_day_billing_boundaries";
            referencedColumns: [
              "id",
              "ad_account_id",
              "google_ads_customer_id",
              "google_local_date",
              "google_time_zone",
              "currency",
            ];
          },
        ];
      };
      reviewed_full_day_billing_boundaries: {
        Row: Row<ReviewedFullDayBillingBoundary>;
        Insert: Insert<
          ReviewedFullDayBillingBoundary,
          "id" | "sealed_at" | "sealed_by"
        >;
        Update: Partial<ReviewedFullDayBillingBoundary>;
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
          | "revenue_share_enabled"
          | "revenue_share_rate"
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
      product_costs: {
        Row: Row<ProductCost>;
        Insert: Insert<
          ProductCost,
          "id" | "currency" | "effective_from" | "created_at"
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
    Views: {
      historical_billing_rollover_review: {
        Row: Row<HistoricalBillingRolloverReview>;
        Relationships: [];
      };
    };
    Functions: {
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
      /** Start one durable automatic-billing run receipt (0036). */
      /** Record that a client owes nothing for one closed-week period. */
      /** Store or replace one encrypted operational credential. */
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
      /** Undo a skip that has not been acted on. */
      remove_billing_cycle_skip: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_removed_by: string;
        };
        Returns: boolean;
      };
      begin_billing_automation_run: {
        Args: { p_issuance_enabled: boolean };
        Returns: BillingAutomationRun[];
      };
      /** Seed all eligible post-cutover client/week work through a closed Sunday. */
      seed_billing_automation_items: {
        Args: { p_run_id: string; p_closed_through: string };
        Returns: number;
      };
      /** Prove that every relevant account has exact evidence and zero billable spend. */
      billing_automation_exact_zero_account_count: {
        Args: {
          p_client_id: string;
          p_period_start: string;
          p_period_end: string;
        };
        Returns: number;
      };
      /** Claim the oldest retryable client/week work with a fenced generation. */
      claim_billing_automation_items: {
        Args: { p_run_id: string; p_limit?: number };
        Returns: BillingAutomationItem[];
      };
      /** Admin-only compact count of non-terminal work by client. */
      billing_automation_attention_clients: {
        Args: Record<string, never>;
        Returns: { client_id: string; item_count: number }[];
      };
      /** Admin-only most recent automatic-billing run receipt. */
      latest_billing_automation_run: {
        Args: Record<string, never>;
        Returns: BillingAutomationRun[];
      };
      /** Commit one fenced automatic item outcome (0036). */
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
      /** Finalise one automatic-billing run's aggregate counters (0036). */
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
      /** Creates or returns the one automation draft for a sealed rollover. */
      create_historical_rollover_invoice: {
        Args: { p_rollover_id: string };
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
      /**
       * Service-only idempotent commit of live Google customer metadata for a
       * reviewed pre-v3 start. It never changes OAuth or ad-account status.
       */
      commit_reviewed_full_day_billing_start: {
        Args: {
          p_account_id: string;
          p_metadata_capture_id: string;
          p_google_ads_customer_id: string;
          p_google_local_date: string;
          p_google_time_zone: string;
          p_currency: "EUR";
          p_metadata_capture_started_at: string;
          p_metadata_captured_at: string;
          p_metadata_authority: "client_oauth";
          p_metadata_contract: "google-customer-metadata-v1";
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
