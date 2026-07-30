"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, ShieldOff, Store, TriangleAlert, UserPlus, X } from "lucide-react";

import type {
  AccountRequest,
  AdAccount,
  Client,
  Profile,
} from "@/lib/supabase/types";
import type { ClientBillingSummary } from "@/lib/billing/invoices";
import { money } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { InlineRename } from "@/components/admin/inline-rename";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";

/**
 * Admin-side client management. English-only for now (the rest of the admin
 * is EN/PT — translate when the flows settle).
 *
 * Every action here is an ordinary RLS-checked write with the anon key: the
 * admin policies (`public.is_admin()`) are what authorise it, never a
 * service key in the browser.
 */
export function ClientsManager({
  clients,
  pendingClients,
  candidates,
  pendingAccounts,
  pendingRequests,
  partnerOf,
  adminId,
  stripeReady,
}: {
  clients: (Client & {
    accounts: number;
    billing: ClientBillingSummary | null;
    /** A saved card on the Stripe customer — i.e. Monday charges itself. */
    hasCard: boolean;
  })[];
  /** self-registered clients waiting on approval_status (migration 0002) */
  pendingClients: Client[];
  /** profiles with no portal_clients row — can be promoted to clients */
  candidates: Profile[];
  pendingAccounts: (AdAccount & { owner: string })[];
  pendingRequests: (AccountRequest & { owner: string })[];
  /**
   * portal_clients id → the clients they are a sócio of (migration 0015).
   *
   * Shown in the approval queue because rejecting is not only about this
   * person's own account: a rejection also cuts them out of every workspace
   * that invited them, and that is not something to click blind.
   */
  partnerOf: Record<string, string[]>;
  adminId: string;
  /** Stripe configured at all — without it the badge means nothing. */
  stripeReady: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  // Who owes money that is past its due date, and how much of it.
  const lateClients = clients.filter((client) => (client.billing?.overdue ?? 0) > 0);
  const lateCount = lateClients.reduce((sum, client) => sum + client.billing!.overdue, 0);
  const lateAmount = lateClients.reduce((sum, client) => sum + client.billing!.overdueAmount, 0);

  async function run(key: string, action: () => Promise<{ error: { message: string } | null }>) {
    setBusy(key);
    setError(null);
    const { error: actionError } = await action();
    setBusy(null);
    if (actionError) {
      setError(actionError.message);
      return;
    }
    router.refresh();
  }

  const supabase = () => createClient();

  return (
    <div className="space-y-8">
      {error && <FormAlert>{error}</FormAlert>}

      {/* ---- clients awaiting approval --------------------------------- */}
      <section className="space-y-3">
        <h2 className="label-caps">New client accounts ({pendingClients.length})</h2>
        {pendingClients.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">No accounts waiting for approval.</p>
        ) : (
          <ul className="space-y-2">
            {pendingClients.map((client) => (
              <li
                key={client.id}
                className="panel flex flex-wrap items-center gap-3 border-[var(--accent-gold)]/25 p-4"
              >
                <Avatar name={client.full_name} src={client.avatar_url} seed={client.id} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {client.full_name}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {client.email} · registered {new Date(client.created_at).toLocaleDateString()}
                  </p>
                  {(partnerOf[client.id]?.length ?? 0) > 0 && (
                    <p className="mt-1 truncate text-[12px] text-[var(--accent-gold-strong)]">
                      Partner of {partnerOf[client.id].join(", ")} — rejecting also removes that
                      access.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === `approve-${client.id}`}
                    onClick={() =>
                      run(`approve-${client.id}`, async () =>
                        supabase()
                          .from("portal_clients")
                          .update({
                            approval_status: "approved",
                            approved_at: new Date().toISOString(),
                            approved_by: adminId,
                          })
                          .eq("id", client.id),
                      )
                    }
                  >
                    <Check />
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === `reject-${client.id}`}
                    onClick={() =>
                      run(`reject-${client.id}`, async () =>
                        supabase()
                          .from("portal_clients")
                          .update({
                            approval_status: "rejected",
                            approved_at: new Date().toISOString(),
                            approved_by: adminId,
                          })
                          .eq("id", client.id),
                      )
                    }
                  >
                    <X />
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- pending ad accounts -------------------------------------- */}
      <section className="space-y-3">
        <h2 className="label-caps">Pending ad accounts ({pendingAccounts.length})</h2>
        {pendingAccounts.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">Nothing waiting for approval.</p>
        ) : (
          <ul className="space-y-2">
            {pendingAccounts.map((account) => (
              <li key={account.id} className="panel flex flex-wrap items-center gap-3 p-4">
                <Store className="size-4 shrink-0 text-[var(--accent-gold)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {account.store_name}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {account.owner}
                    {account.google_ads_customer_id && ` · ${account.google_ads_customer_id}`}
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === `acc-${account.id}`}
                  onClick={() =>
                    run(`acc-${account.id}`, async () =>
                      supabase().from("ad_accounts").update({ status: "active" }).eq("id", account.id),
                    )
                  }
                >
                  <Check />
                  Activate
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- pending requests ------------------------------------------ */}
      <section className="space-y-3">
        <h2 className="label-caps">Account requests ({pendingRequests.length})</h2>
        {pendingRequests.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">No open requests.</p>
        ) : (
          <ul className="space-y-2">
            {pendingRequests.map((request) => (
              <li key={request.id} className="panel flex flex-wrap items-center gap-3 p-4">
                <Badge variant={request.request_type === "google_ads" ? "gold" : "neutral"}>
                  {request.request_type === "google_ads" ? "Google Ads" : "Shopify"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {request.store_name ?? request.myshopify_url ?? "—"}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {request.owner}
                    {request.google_ads_customer_id && ` · ${request.google_ads_customer_id}`}
                    {request.shopify_collaborator_code && ` · code ${request.shopify_collaborator_code}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === `req-approve-${request.id}`}
                    onClick={() =>
                      run(`req-approve-${request.id}`, async () => {
                        const client = supabase();
                        // Approving a Google Ads request also provisions the
                        // ad account so the client sees it immediately.
                        if (request.request_type === "google_ads") {
                          const { error: insertError } = await client.from("ad_accounts").insert({
                            client_id: request.client_id,
                            store_name: request.store_name ?? "New store",
                            google_ads_customer_id: request.google_ads_customer_id,
                            status: "active",
                          });
                          if (insertError) return { error: insertError };
                        }
                        return client
                          .from("account_requests")
                          .update({ status: "approved" })
                          .eq("id", request.id);
                      })
                    }
                  >
                    <Check />
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === `req-reject-${request.id}`}
                    onClick={() =>
                      run(`req-reject-${request.id}`, async () =>
                        supabase()
                          .from("account_requests")
                          .update({ status: "rejected" })
                          .eq("id", request.id),
                      )
                    }
                  >
                    <X />
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- portal clients --------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="label-caps">Portal clients ({clients.length})</h2>

        {/* Billing state, summed across clients. Collapsed to one line unless
            money is actually late — an alert that is always on is furniture. */}
        {lateClients.length > 0 && (
          <details className="group/late overflow-hidden rounded-[var(--radius-card)] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/8">
            <summary className="transition-smooth flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-[var(--danger-red)]/12 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-[var(--danger-red)] transition-transform group-open/late:rotate-90" />
              <TriangleAlert className="size-4 shrink-0 text-[var(--danger-red)]" aria-hidden />
              <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-[var(--text-primary)]">
                {lateCount} {lateCount === 1 ? "invoice" : "invoices"} overdue across{" "}
                {lateClients.length} {lateClients.length === 1 ? "client" : "clients"}
              </span>
              <span className="shrink-0 text-[13.5px] font-semibold text-[var(--danger-red)] tabular-nums">
                {money(lateAmount, "EUR")}
              </span>
            </summary>

            <ul className="border-t border-[var(--danger-red)]/20">
              {lateClients.map((client) => (
                <li
                  key={client.id}
                  className="flex flex-wrap items-center gap-3 border-b border-[var(--danger-red)]/10 px-4 py-2.5 last:border-b-0"
                >
                  <Avatar name={client.full_name} src={client.avatar_url} seed={client.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                    {client.full_name}
                  </span>
                  <Badge variant="danger">
                    {client.billing!.overdue} overdue
                  </Badge>
                  <span className="text-[13px] font-medium text-[var(--text-primary)] tabular-nums">
                    {money(client.billing!.overdueAmount, "EUR")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {clients.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            No portal clients yet. Promote a registered user below, or create one in
            Supabase (Authentication → Add user) and it will appear in the list.
          </p>
        ) : (
          <ul className="space-y-2">
            {clients.map((client) => (
              <li key={client.id} className="panel flex flex-wrap items-center gap-3 p-4">
                <Avatar name={client.full_name} src={client.avatar_url} seed={client.id} size="sm" />
                <div className="min-w-0 flex-1">
                  {/* The name is the trigger: clients sign up with whatever they
                      type, and this is where the team tidies it. The email is
                      NOT editable here — it is the login identity, and moving it
                      means re-verifying an address. */}
                  <InlineRename
                    value={client.full_name}
                    title="Client name"
                    help="Shown across the admin and in their own portal."
                    maxLength={80}
                    emptyMessage="A client needs a name."
                    onSave={async (next) => {
                      const { error: renameError } = await supabase()
                        .from("portal_clients")
                        .update({ full_name: next })
                        .eq("id", client.id);
                      if (renameError) return renameError.message;
                      router.refresh();
                      return null;
                    }}
                  >
                    <span className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                      {client.full_name}
                    </span>
                  </InlineRename>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">{client.email}</p>
                </div>
                {/* Whether Monday charges them or merely emails a link. Worth
                    a badge of its own: an agency going live needs to know how
                    many clients will actually settle without being chased. */}
                {stripeReady && (
                  <Badge variant={client.hasCard ? "success" : "neutral"}>
                    {client.hasCard ? "auto-charge" : "pays by link"}
                  </Badge>
                )}
                {client.billing && client.billing.overdue > 0 && (
                  <Badge variant="danger">
                    {client.billing.overdue} overdue · {money(client.billing.overdueAmount, "EUR")}
                  </Badge>
                )}
                {client.billing &&
                  client.billing.overdue === 0 &&
                  client.billing.open > 0 && (
                    <Badge variant="warning">
                      {client.billing.open} unpaid · {money(client.billing.openAmount, "EUR")}
                    </Badge>
                  )}
                {client.approval_status === "rejected" ? (
                  <Badge variant="danger">rejected</Badge>
                ) : (
                  <Badge variant="neutral">
                    {client.accounts} {client.accounts === 1 ? "store" : "stores"}
                  </Badge>
                )}
                {client.approval_status === "rejected" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === `reapprove-${client.id}`}
                    onClick={() =>
                      run(`reapprove-${client.id}`, async () =>
                        supabase()
                          .from("portal_clients")
                          .update({
                            approval_status: "approved",
                            approved_at: new Date().toISOString(),
                            approved_by: adminId,
                          })
                          .eq("id", client.id),
                      )
                    }
                  >
                    <Check />
                    Approve
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === `revoke-${client.id}`}
                  onClick={() =>
                    run(`revoke-${client.id}`, async () =>
                      supabase().from("portal_clients").delete().eq("id", client.id),
                    )
                  }
                  title="Removes portal access. Their auth account and CRM record stay."
                >
                  <ShieldOff />
                  Revoke access
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- promote a registered user ---------------------------------- */}
      <section className="space-y-3">
        <h2 className="label-caps">Registered users without portal access ({candidates.length})</h2>
        {candidates.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            Every registered user already has portal access or is staff.
          </p>
        ) : (
          <ul className="space-y-2">
            {candidates.map((profile) => (
              <li key={profile.id} className="panel flex flex-wrap items-center gap-3 p-4">
                <Avatar name={profile.full_name} src={profile.avatar_url} seed={profile.id} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {profile.full_name}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">{profile.email}</p>
                </div>
                <Badge variant={profile.role === "admin" ? "gold" : "neutral"}>{profile.role}</Badge>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === `promote-${profile.id}`}
                  onClick={() =>
                    run(`promote-${profile.id}`, async () =>
                      // Explicitly approved: the column defaults to 'pending'
                      // for self-signups, but an admin doing this by hand IS
                      // the approval.
                      supabase().from("portal_clients").insert({
                        id: profile.id,
                        full_name: profile.full_name,
                        email: profile.email,
                        avatar_url: profile.avatar_url,
                        approval_status: "approved",
                        approved_at: new Date().toISOString(),
                        approved_by: adminId,
                      }),
                    )
                  }
                >
                  <UserPlus />
                  Make client
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
