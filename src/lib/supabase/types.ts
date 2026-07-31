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
export type SourceCategory = "platform" | "supplier" | "incorporation" | "saas" | "other";
export type CommissionStatus = "pending" | "confirmed" | "paid";
export type ExpenseCategory =
  | "ads"
  | "tools"
  | "salaries"
  | "contractors"
  | "office"
  | "taxes"
  | "other";

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
  gross_amount: number;
  rate: number;
  amount: number;
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

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

/**
 * What an invoice line is for. `spend` is the Google Ads money the agency
 * fronted and is passing through at cost; `fee` and `rev_share` are the two
 * ways the agency earns on top of it.
 */
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
  issued_at: string | null;
  paid_at: string | null;
  /** Set when Stripe reported a failed charge; cleared once it is paid (0014). */
  payment_failed_at: string | null;
  created_at: string;
  updated_at: string;
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
type Insert<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>;

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
          "id" | "category" | "default_rate" | "recurring" | "active" | "notes" | "created_at"
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
          | "issued_at"
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
        ];
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
          "id" | "invited_by" | "status" | "created_at" | "accepted_at" | "accepted_by"
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
        Insert: Insert<StoreProduct, "id" | "price" | "currency" | "source" | "last_seen" | "created_at">;
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
        Insert: Insert<ProductCost, "id" | "currency" | "effective_from" | "created_at">;
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
          "id" | "status" | "file_count" | "size_mb" | "thumbnail_urls" | "created_at"
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
      /** The one portal_clients column a sócio may set on the owner's row (0015). */
      set_workspace_stripe_customer: {
        Args: { p_client_id: string; p_customer_id: string };
        Returns: undefined;
      };
      /**
       * Links the caller to whoever owns that affiliate code (migration 0022).
       * Returns a status string — 'ok', 'unknown_code', 'own_code',
       * 'already_referred', 'not_a_client', 'empty' or 'not_signed_in' — never
       * the referrer, so a code cannot be used to probe for other clients.
       */
      claim_referral_code: {
        Args: { p_code: string };
        Returns: string;
      };
      /**
       * Re-prices every account whose billed rate no longer matches the rule
       * (migration 0023). Returns how many changed. The hourly cron's job: a
       * referral going dormant is a change nothing else would notice.
       */
      refresh_all_referral_rates: {
        Args: Record<string, never>;
        Returns: number;
      };
      /**
       * Per-referral status for a workspace — 'counting', 'pending', 'partner'
       * or 'inactive'. Names and statuses only: the referrer must never be able
       * to read the referred client's stores or spend.
       */
      referral_summary: {
        Args: { p_client_id: string };
        Returns: { name: string; status: string }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
