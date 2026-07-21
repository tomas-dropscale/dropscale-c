"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldOff, Store, UserPlus, X } from "lucide-react";

import type {
  AccountRequest,
  AdAccount,
  Client,
  Profile,
} from "@/lib/supabase/types";
import { Avatar } from "@/components/ui/avatar";
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
  adminId,
}: {
  clients: (Client & { accounts: number })[];
  /** self-registered clients waiting on approval_status (migration 0002) */
  pendingClients: Client[];
  /** profiles with no portal_clients row — can be promoted to clients */
  candidates: Profile[];
  pendingAccounts: (AdAccount & { owner: string })[];
  pendingRequests: (AccountRequest & { owner: string })[];
  adminId: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

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
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {client.full_name}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">{client.email}</p>
                </div>
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
