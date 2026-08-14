import type { Metadata } from "next";

import { BillingAdminView } from "@/components/admin/billing-admin-view";
import { ClientsManager } from "@/components/admin/clients-manager";
import { ReportingBindingsQueue } from "@/components/admin/reporting-bindings-queue";
import { PageContainer } from "@/components/ui/page-container";
import { fetchAdminBillingDashboard } from "@/lib/billing/invoices";
import { listClientReportingCutoverQueue } from "@/lib/client-onboarding/reporting-cutover";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { getServerDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  AccountRequest,
  AdAccount,
  AdAccountBillingEnd,
  AdAccountBillingStart,
} from "@/lib/supabase/types";

export const metadata: Metadata = { title: "Billing" };

async function loadFinancialOperations() {
  // Bindings are service-only evidence. Re-authorise the interactive admin
  // before constructing the service client, then select only lifecycle IDs.
  await requireClientOnboardingAdmin();
  const supabase = await createClient();
  const service = createServiceClient();
  const reservedBindingsPromise = service
    ? service
        .from("client_reporting_bindings")
        .select("ad_account_id, status")
        .in("status", ["active", "staged"])
    : Promise.resolve({
        data: null,
        error: new Error("Reporting binding service is unavailable."),
      });
  const [
    clientsRes,
    profilesRes,
    accountsRes,
    billingStartsRes,
    billingEndsRes,
    requestsRes,
    reservedBindingsRes,
  ] = await Promise.all([
      supabase.from("portal_clients").select("id, full_name"),
      supabase.from("profiles").select("id, role"),
      supabase
        .from("ad_accounts")
        .select(
          "id, client_id, store_name, google_ads_customer_id, status, reporting_role, currency, breakeven_roas, lifetime_ads_budget_usd, shopify_url, shopify_connected, shopify_client_id, shopify_scopes, color_dot, created_at, google_ads_connected_email, google_ads_connected, commission_rate, list_commission_rate, shopify_token_last4, shopify_connected_at, default_product_cost_pct, payment_fee_pct, payment_fee_fixed, shipping_cost_per_order, revenue_share_enabled",
        )
        .order("created_at", { ascending: true }),
      supabase
        .from("ad_account_billing_starts")
        .select(
          "id, ad_account_id, google_ads_customer_id, google_local_date, google_time_zone, currency, baseline_cost_micros, capture_started_at, captured_at, capture_id, source, reviewed_by, created_at",
        ),
      supabase
        .from("ad_account_billing_ends")
        .select(
          "id, ad_account_id, billing_start_id, google_ads_customer_id, google_local_date, google_time_zone, currency, end_cost_micros, capture_started_at, captured_at, capture_id, source, reviewed_by, created_at",
        ),
      supabase
        .from("account_requests")
        .select(
          "id, client_id, request_type, google_ads_customer_id, store_name, shopify_collaborator_code, myshopify_url, status, created_at",
        )
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
      reservedBindingsPromise,
    ]);

  // Do not present a partial financial queue as complete. The account and
  // boundary reads have explicit fail-closed banners below; client ownership
  // and residual requests do not, so a failed read must fail the page.
  if (clientsRes.error || requestsRes.error) {
    throw clientsRes.error ?? requestsRes.error;
  }

  const allAccounts = (accountsRes.data ?? []).map(
    (account) =>
      ({
        ...account,
        google_ads_refresh_token: null,
        shopify_admin_token: null,
      }) satisfies AdAccount,
  );
  const nameById = new Map(
    (clientsRes.data ?? []).map((client) => [client.id, client.full_name]),
  );
  const adminIds = new Set(
    (profilesRes.data ?? [])
      .filter((profile) => profile.role === "admin")
      .map((profile) => profile.id),
  );
  const billingStartByAccount = new Map(
    ((billingStartsRes.data ?? []) as AdAccountBillingStart[]).map((start) => [
      start.ad_account_id,
      start,
    ]),
  );
  const billingEndByAccount = new Map(
    ((billingEndsRes.data ?? []) as AdAccountBillingEnd[]).map((end) => [
      end.ad_account_id,
      end,
    ]),
  );
  const reservedNormalizedAccountIds = new Set(
    (reservedBindingsRes.data ?? []).map((binding) => binding.ad_account_id),
  );
  const billingStartAuditFailed = Boolean(
    accountsRes.error ||
      profilesRes.error ||
      billingStartsRes.error ||
      reservedBindingsRes.error,
  );
  const billingBoundaryAuditFailed = Boolean(
    accountsRes.error || profilesRes.error || billingStartsRes.error || billingEndsRes.error,
  );

  return {
    pendingAccounts: billingStartAuditFailed
      ? []
      : allAccounts
          .filter(
            (account) =>
              account.status === "pending" &&
              !(
                account.reporting_role === "shopify_anchor" &&
                account.google_ads_customer_id === null
              ) &&
              (account.reporting_role === "legacy_hybrid" ||
                reservedNormalizedAccountIds.has(account.id)),
          )
          .map((account) => ({
            ...account,
            owner: nameById.get(account.client_id) ?? "Unknown client",
          })),
    untrackedAccounts: billingStartAuditFailed
      ? []
      : allAccounts
          .filter(
            (account) =>
              (account.status === "active" || account.status === "suspended") &&
              !adminIds.has(account.client_id) &&
              !billingStartByAccount.has(account.id),
          )
          .map((account) => ({
            ...account,
            owner: nameById.get(account.client_id) ?? "Unknown client",
          })),
    billingStartAuditFailed,
    billingAccounts: billingBoundaryAuditFailed
      ? []
      : allAccounts.flatMap((account) => {
          if (account.status !== "active" && account.status !== "suspended") return [];
          if (adminIds.has(account.client_id)) return [];
          const billingStart = billingStartByAccount.get(account.id);
          if (!billingStart) return [];
          return [
            {
              ...account,
              owner: nameById.get(account.client_id) ?? "Unknown client",
              billingStart,
              billingEnd: billingEndByAccount.get(account.id) ?? null,
            },
          ];
        }),
    billingBoundaryAuditFailed,
    pendingRequests: ((requestsRes.data ?? []) as AccountRequest[]).map((request) => ({
      ...request,
      owner: nameById.get(request.client_id) ?? "Unknown client",
    })),
  };
}

/**
 * Read-only on render. Issuing an invoice and refreshing the ledger are both
 * explicit POST actions in the client component below.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const [{ week }, { d }] = await Promise.all([searchParams, getServerDictionary()]);
  const [dashboard, operations, reportingCutover] = await Promise.all([
    fetchAdminBillingDashboard(week),
    loadFinancialOperations(),
    listClientReportingCutoverQueue(),
  ]);

  return (
    <PageContainer title={d.adminBilling.title} description={d.adminBilling.subtitle}>
      <div className="space-y-10">
        <BillingAdminView dashboard={dashboard} />
        <section id="financial-operations" aria-labelledby="financial-operations-title">
          <div className="mb-4">
            <h2
              id="financial-operations-title"
              className="text-[16px] font-semibold text-[var(--text-primary)]"
            >
              Financial operations
            </h2>
            <p className="mt-1 max-w-4xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              Approve pending accounts and requests, capture missing Google spend baselines, and
              manage immutable billing boundaries.
            </p>
          </div>
          <div className="mb-8">
            <ReportingBindingsQueue queue={reportingCutover} />
          </div>
          <ClientsManager
            clients={[]}
            pendingClients={[]}
            candidates={[]}
            pendingAccounts={operations.pendingAccounts}
            untrackedAccounts={operations.untrackedAccounts}
            billingStartAuditFailed={operations.billingStartAuditFailed}
            billingAccounts={operations.billingAccounts}
            billingBoundaryAuditFailed={operations.billingBoundaryAuditFailed}
            pendingRequests={operations.pendingRequests}
            partnerOf={{}}
            adminId=""
            financialOnly
          />
        </section>
      </div>
    </PageContainer>
  );
}
