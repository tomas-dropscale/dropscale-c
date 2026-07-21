/**
 * Hand-written database types for the client-portal tables.
 *
 * The Relationships metadata is not optional decoration: without it,
 * PostgREST embeds (`select("*, ad_accounts(*)")`) resolve to
 * `SelectQueryError` at the type level.
 */

export type AdAccountStatus = "active" | "suspended" | "pending";
export type RequestType = "google_ads" | "shopify";
export type RequestStatus = "pending" | "approved" | "rejected";
export type CampaignStatus = "active" | "paused" | "ended";
export type DeliveryStatus = "draft" | "published";
export type BillingProfileType = "company" | "individual";

export type Database = {
  public: {
    Tables: {
      portal_clients: {
        Row: {
          id: string;
          full_name: string;
          email: string;
          avatar_url: string | null;
          crm_client_id: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          full_name: string;
          email: string;
          avatar_url?: string | null;
          crm_client_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string;
          email?: string;
          avatar_url?: string | null;
          crm_client_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      billing_profiles: {
        Row: {
          client_id: string;
          profile_type: BillingProfileType;
          currency: string;
          available_budget: number | null;
          updated_at: string;
        };
        Insert: {
          client_id: string;
          profile_type?: BillingProfileType;
          currency?: string;
          available_budget?: number | null;
          updated_at?: string;
        };
        Update: {
          client_id?: string;
          profile_type?: BillingProfileType;
          currency?: string;
          available_budget?: number | null;
          updated_at?: string;
        };
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
        Row: {
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
        };
        Insert: {
          id?: string;
          client_id: string;
          store_name: string;
          google_ads_customer_id?: string | null;
          status?: AdAccountStatus;
          currency?: string;
          breakeven_roas?: number | null;
          lifetime_ads_budget_usd?: number | null;
          shopify_url?: string | null;
          shopify_connected?: boolean;
          shopify_client_id?: string | null;
          shopify_scopes?: string | null;
          color_dot?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          store_name?: string;
          google_ads_customer_id?: string | null;
          status?: AdAccountStatus;
          currency?: string;
          breakeven_roas?: number | null;
          lifetime_ads_budget_usd?: number | null;
          shopify_url?: string | null;
          shopify_connected?: boolean;
          shopify_client_id?: string | null;
          shopify_scopes?: string | null;
          color_dot?: string;
          created_at?: string;
        };
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
        Row: {
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
        Insert: {
          id?: string;
          client_id: string;
          request_type: RequestType;
          google_ads_customer_id?: string | null;
          store_name?: string | null;
          shopify_collaborator_code?: string | null;
          myshopify_url?: string | null;
          status?: RequestStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          request_type?: RequestType;
          google_ads_customer_id?: string | null;
          store_name?: string | null;
          shopify_collaborator_code?: string | null;
          myshopify_url?: string | null;
          status?: RequestStatus;
          created_at?: string;
        };
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
        Row: {
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
        Insert: {
          id?: string;
          ad_account_id: string;
          name: string;
          status?: CampaignStatus;
          spend?: number;
          impressions?: number;
          clicks?: number;
          ctr?: number;
          cpc?: number;
          daily_budget?: number | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          ad_account_id?: string;
          name?: string;
          status?: CampaignStatus;
          spend?: number;
          impressions?: number;
          clicks?: number;
          ctr?: number;
          cpc?: number;
          daily_budget?: number | null;
          updated_at?: string;
        };
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
        Row: {
          id: string;
          ad_account_id: string;
          name: string;
          status: DeliveryStatus;
          file_count: number;
          size_mb: number;
          thumbnail_urls: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          ad_account_id: string;
          name: string;
          status?: DeliveryStatus;
          file_count?: number;
          size_mb?: number;
          thumbnail_urls?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          ad_account_id?: string;
          name?: string;
          status?: DeliveryStatus;
          file_count?: number;
          size_mb?: number;
          thumbnail_urls?: string[];
          created_at?: string;
        };
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
    Views: Record<string, never>;
    Functions: {
      owns_ad_account: {
        Args: { p_ad_account_id: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** A portal login. Not the same as the admin CRM record in public.clients. */
export type Client = Database["public"]["Tables"]["portal_clients"]["Row"];
export type BillingProfile = Database["public"]["Tables"]["billing_profiles"]["Row"];
export type AdAccount = Database["public"]["Tables"]["ad_accounts"]["Row"];
export type AccountRequest = Database["public"]["Tables"]["account_requests"]["Row"];
export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type CreativeDelivery = Database["public"]["Tables"]["creative_deliveries"]["Row"];
