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
};

export type BillingProfile = {
  client_id: string;
  profile_type: BillingProfileType;
  currency: string;
  available_budget: number | null;
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
  /** % of ad spend the agency bills; admin-only via guard (migration 0006). */
  commission_rate: number;
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
      billing_profiles: {
        Row: Row<BillingProfile>;
        Insert: Insert<BillingProfile, "profile_type" | "currency" | "available_budget" | "updated_at">;
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
      /** Creates the caller's pending portal_clients row (migration 0004). */
      claim_portal_client: {
        Args: Record<string, never>;
        Returns: string;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
