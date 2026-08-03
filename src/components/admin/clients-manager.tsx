"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldOff, Store, UserPlus, X } from "lucide-react";

import type {
  AccountRequest,
  AdAccount,
  AdAccountBillingEnd,
  AdAccountBillingStart,
  Client,
  Profile,
} from "@/lib/supabase/types";
import { Avatar } from "@/components/ui/avatar";
import { InlineRename } from "@/components/admin/inline-rename";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";

type BillingStartReceipt = {
  storeName: string;
  googleAdsCustomerId: string;
  googleLocalDate: string;
  googleTimeZone: string;
  currency: string;
  baselineCostMicros: string;
  capturedAt: string;
};

type BillingEndReceipt = {
  storeName: string;
  googleAdsCustomerId: string;
  googleLocalDate: string;
  googleTimeZone: string;
  currency: string;
  endCostMicros: string;
  capturedAt: string;
};

type BillingAccount = AdAccount & {
  owner: string;
  billingStart: AdAccountBillingStart;
  billingEnd: AdAccountBillingEnd | null;
};

function formatMicros(micros: string, currency: string) {
  try {
    const value = BigInt(micros);
    const microsPerUnit = BigInt(1_000_000);
    const whole = value / microsPerUnit;
    const rawFraction = (value % microsPerUnit).toString().padStart(6, "0");
    const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
    const symbol = currency === "EUR" ? "€" : `${currency} `;
    return `${symbol}${whole.toLocaleString("en-IE")}.${fraction}`;
  } catch {
    return `${currency} ${micros} micros`;
  }
}

function formatGoogleDay(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
}

/**
 * Admin-side client management. English-only for now (the rest of the admin
 * is EN/PT — translate when the flows settle).
 *
 * Ordinary management actions are RLS-checked browser writes. Starting Google
 * billing is different: the browser calls an admin-only server route, which
 * verifies live agency access before one service-side atomic commit.
 */
export function ClientsManager({
  clients,
  pendingClients,
  candidates,
  pendingAccounts,
  untrackedAccounts,
  billingStartAuditFailed,
  billingAccounts,
  billingBoundaryAuditFailed,
  pendingRequests,
  partnerOf,
  adminId,
}: {
  clients: (Client & {
    accounts: number;
  })[];
  /** self-registered clients waiting on approval_status (migration 0002) */
  pendingClients: Client[];
  /** profiles with no portal_clients row — can be promoted to clients */
  candidates: Profile[];
  pendingAccounts: (AdAccount & { owner: string })[];
  /** Legacy active/suspended accounts that predate the immutable opening counter. */
  untrackedAccounts: (AdAccount & { owner: string })[];
  /** The evidence query failed; never present an empty response as a real audit result. */
  billingStartAuditFailed: boolean;
  /** Approved accounts with their immutable commercial start/end evidence. */
  billingAccounts: BillingAccount[];
  /** A boundary query failed; stopping billing must fail closed. */
  billingBoundaryAuditFailed: boolean;
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
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<BillingStartReceipt | null>(null);
  const [endReceipt, setEndReceipt] = React.useState<BillingEndReceipt | null>(null);
  const [endTarget, setEndTarget] = React.useState<BillingAccount | null>(null);
  const [endConfirmed, setEndConfirmed] = React.useState(false);
  const trackingGapCount = billingStartAuditFailed ? "unavailable" : untrackedAccounts.length;

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

  function googleStartBlockReason(customerId: string | null) {
    if (billingStartAuditFailed) {
      return "Billing-start records are unavailable. Refresh first.";
    }
    if (!customerId) return "Add a Google Ads customer ID first.";
    return undefined;
  }

  async function activateGoogle(
    key: string,
    target: { accountId: string } | { requestId: string },
  ) {
    setBusy(key);
    setError(null);
    setReceipt(null);

    try {
      const response = await fetch("/api/admin/google-ads/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: unknown;
            account?: { storeName?: unknown };
            billingStart?: {
              googleAdsCustomerId?: unknown;
              googleLocalDate?: unknown;
              googleTimeZone?: unknown;
              currency?: unknown;
              baselineCostMicros?: unknown;
              capturedAt?: unknown;
            };
          }
        | null;

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Google tracking could not be started.",
        );
      }

      const account = payload?.account;
      const start = payload?.billingStart;
      if (
        typeof account?.storeName !== "string" ||
        typeof start?.googleAdsCustomerId !== "string" ||
        typeof start.googleLocalDate !== "string" ||
        typeof start.googleTimeZone !== "string" ||
        typeof start.currency !== "string" ||
        typeof start.baselineCostMicros !== "string" ||
        typeof start.capturedAt !== "string"
      ) {
        throw new Error(
          "Tracking started, but its confirmation receipt was incomplete. Refresh the page.",
        );
      }

      setReceipt({
        storeName: account.storeName,
        googleAdsCustomerId: start.googleAdsCustomerId,
        googleLocalDate: start.googleLocalDate,
        googleTimeZone: start.googleTimeZone,
        currency: start.currency,
        baselineCostMicros: start.baselineCostMicros,
        capturedAt: start.capturedAt,
      });
      router.refresh();
    } catch (activationError) {
      setError(
        activationError instanceof Error
          ? activationError.message
          : "Google tracking could not be started.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function terminateGoogle() {
    if (!endTarget || !endConfirmed || endTarget.billingEnd) return;
    const key = `end-google-${endTarget.id}`;
    setBusy(key);
    setError(null);
    setEndReceipt(null);

    try {
      const response = await fetch("/api/admin/google-ads/terminate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: endTarget.id }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: unknown;
            account?: { storeName?: unknown };
            billingEnd?: {
              googleAdsCustomerId?: unknown;
              googleLocalDate?: unknown;
              googleTimeZone?: unknown;
              currency?: unknown;
              endCostMicros?: unknown;
              capturedAt?: unknown;
            };
          }
        | null;

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Google billing could not be stopped.",
        );
      }

      const account = payload?.account;
      const end = payload?.billingEnd;
      if (
        typeof account?.storeName !== "string" ||
        typeof end?.googleAdsCustomerId !== "string" ||
        typeof end.googleLocalDate !== "string" ||
        typeof end.googleTimeZone !== "string" ||
        typeof end.currency !== "string" ||
        typeof end.endCostMicros !== "string" ||
        typeof end.capturedAt !== "string"
      ) {
        throw new Error(
          "Billing stopped, but its confirmation receipt was incomplete. Refresh the page.",
        );
      }

      setEndReceipt({
        storeName: account.storeName,
        googleAdsCustomerId: end.googleAdsCustomerId,
        googleLocalDate: end.googleLocalDate,
        googleTimeZone: end.googleTimeZone,
        currency: end.currency,
        endCostMicros: end.endCostMicros,
        capturedAt: end.capturedAt,
      });
      setEndTarget(null);
      setEndConfirmed(false);
      router.refresh();
    } catch (terminationError) {
      setError(
        terminationError instanceof Error
          ? terminationError.message
          : "Google billing could not be stopped.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {error && <FormAlert>{error}</FormAlert>}
      {receipt && (
        <FormAlert tone="success">
          <span className="font-semibold">Google tracking baseline saved for {receipt.storeName}.</span>{" "}
          Opening counter: {formatMicros(receipt.baselineCostMicros, receipt.currency)} on{" "}
          {formatGoogleDay(receipt.googleLocalDate)} ({receipt.googleTimeZone}), captured{" "}
          {new Date(receipt.capturedAt).toLocaleString("en-GB")}. Spend already present at this
          reported counter is excluded from the agency fee. Google reporting can arrive later;
          this receipt freezes the value returned at capture time, not an instantaneous event
          cutoff. Customer {receipt.googleAdsCustomerId}.
        </FormAlert>
      )}
      {endReceipt && (
        <FormAlert tone="success">
          <span className="font-semibold">Agency billing ended for {endReceipt.storeName}.</span>{" "}
          Closing counter: {formatMicros(endReceipt.endCostMicros, endReceipt.currency)} on{" "}
          {formatGoogleDay(endReceipt.googleLocalDate)} ({endReceipt.googleTimeZone}), captured{" "}
          {new Date(endReceipt.capturedAt).toLocaleString("en-GB")}. The final invoice uses this
          immutable reported boundary. Google reporting can arrive later, so the receipt is not
          an instantaneous event cutoff. Customer{" "}
          {endReceipt.googleAdsCustomerId}.
        </FormAlert>
      )}

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
                  disabled={Boolean(googleStartBlockReason(account.google_ads_customer_id))}
                  title={
                    googleStartBlockReason(account.google_ads_customer_id) ??
                    "Verify agency access and save Google's currently reported opening spend counter."
                  }
                  onClick={() =>
                    activateGoogle(`acc-${account.id}`, { accountId: account.id })
                  }
                >
                  <Check />
                  Verify Google &amp; start tracking
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- legacy accounts without an opening counter --------------- */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="label-caps">Google tracking gaps ({trackingGapCount})</h2>
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
            Active or suspended legacy accounts listed here have no immutable opening Google
            counter. Capture the counter Google reports now; spend already present in that value
            will remain outside agency billing. Google reporting itself can arrive later.
          </p>
        </div>
        {billingStartAuditFailed ? (
          <FormAlert>
            Billing-start records could not be audited. Refresh before capturing any legacy
            account.
          </FormAlert>
        ) : untrackedAccounts.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            Every approved Google Ads account has a billing start.
          </p>
        ) : (
          <ul className="space-y-2">
            {untrackedAccounts.map((account) => (
              <li key={account.id} className="panel flex flex-wrap items-center gap-3 p-4">
                <Store className="size-4 shrink-0 text-[var(--accent-gold)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                      {account.store_name}
                    </p>
                    <Badge variant={account.status === "suspended" ? "neutral" : "gold"}>
                      {account.status}
                    </Badge>
                  </div>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {account.owner}
                    {account.google_ads_customer_id
                      ? ` · ${account.google_ads_customer_id}`
                      : " · no Google Ads customer ID"}
                  </p>
                  {account.status === "suspended" && (
                    <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                      Capturing the baseline will not reactivate this account.
                    </p>
                  )}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === `legacy-acc-${account.id}`}
                  disabled={Boolean(googleStartBlockReason(account.google_ads_customer_id))}
                  title={
                    googleStartBlockReason(account.google_ads_customer_id) ??
                    "Save Google's currently reported opening counter. Suspended accounts remain suspended."
                  }
                  onClick={() =>
                    activateGoogle(`legacy-acc-${account.id}`, { accountId: account.id })
                  }
                >
                  <Check />
                  Verify Google &amp; start tracking
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- immutable Google billing boundaries ---------------------- */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="label-caps">Google billing boundaries ({billingAccounts.length})</h2>
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
            Billing status is separate from the account&apos;s technical active or suspended status.
            Stopping billing captures one Google-local closing counter as currently reported and
            cannot be undone or replaced from the dashboard. Google reporting can arrive with a
            delay, so this is an observed counter boundary rather than an event-time guarantee.
          </p>
        </div>
        {billingBoundaryAuditFailed ? (
          <FormAlert>
            Billing boundary records could not be audited. Refresh before stopping billing for
            any account.
          </FormAlert>
        ) : billingAccounts.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            No approved Google account has an opening billing boundary yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {billingAccounts.map((account) => {
              const ended = account.billingEnd;
              const endBusy = busy === `end-google-${account.id}`;
              return (
                <li key={account.id} className="panel flex flex-wrap items-center gap-3 p-4">
                  <Store className="size-4 shrink-0 text-[var(--accent-gold)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                        {account.store_name}
                      </p>
                      <Badge variant={ended ? "neutral" : "success"}>
                        {ended ? "billing ended" : "billing active"}
                      </Badge>
                      <Badge variant="neutral">account {account.status}</Badge>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                      Started {formatGoogleDay(account.billingStart.google_local_date)} · opening{" "}
                      {formatMicros(
                        String(account.billingStart.baseline_cost_micros),
                        account.billingStart.currency,
                      )}{" "}
                      · {account.billingStart.google_time_zone}
                    </p>
                    {ended ? (
                      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                        Ended {formatGoogleDay(ended.google_local_date)} · closing{" "}
                        {formatMicros(String(ended.end_cost_micros), ended.currency)} · captured{" "}
                        {new Date(ended.captured_at).toLocaleString("en-GB")} · {ended.google_time_zone}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                        {account.owner} · Google customer {account.billingStart.google_ads_customer_id}
                      </p>
                    )}
                  </div>
                  {!ended && (
                    <Button
                      variant="danger"
                      size="sm"
                      loading={endBusy}
                      disabled={Boolean(busy) || billingBoundaryAuditFailed}
                      title="Capture Google's currently reported final counter without changing account status."
                      onClick={() => {
                        setError(null);
                        setEndReceipt(null);
                        setEndConfirmed(false);
                        setEndTarget(account);
                      }}
                    >
                      <ShieldOff />
                      Stop billing now
                    </Button>
                  )}
                </li>
              );
            })}
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
                    disabled={
                      request.request_type === "google_ads" &&
                      Boolean(googleStartBlockReason(request.google_ads_customer_id))
                    }
                    title={
                      request.request_type === "google_ads"
                        ? googleStartBlockReason(request.google_ads_customer_id)
                        : undefined
                    }
                    onClick={() =>
                      request.request_type === "google_ads"
                        ? activateGoogle(`req-approve-${request.id}`, {
                            requestId: request.id,
                          })
                        : run(`req-approve-${request.id}`, async () =>
                            supabase()
                              .from("account_requests")
                              .update({ status: "approved" })
                              .eq("id", request.id),
                          )
                    }
                  >
                    <Check />
                    {request.request_type === "google_ads"
                      ? "Approve & start tracking"
                      : "Approve"}
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
                {client.approval_status !== "rejected" && (
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === `revoke-${client.id}`}
                    onClick={() =>
                      run(`revoke-${client.id}`, async () =>
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
                    title="Revokes portal access without deleting the client or billing history."
                  >
                    <ShieldOff />
                    Revoke access
                  </Button>
                )}
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

      <Dialog
        open={Boolean(endTarget)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEndTarget(null);
            setEndConfirmed(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently stop agency billing?</DialogTitle>
            <DialogDescription>
              {endTarget
                ? `${endTarget.store_name} will receive one immutable closing Google Ads counter as currently reported.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {error && <FormAlert>{error}</FormAlert>}

          {endTarget && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <p>
                  The cumulative spend currently reported for the Google-local day in{" "}
                  {endTarget.billingStart.google_time_zone} becomes the final boundary. The final
                  invoice may include eligible spend up to that captured counter. Google reporting
                  can arrive later, so this is not a guaranteed instantaneous event cutoff.
                </p>
                <p className="mt-2">
                  The account remains <span className="font-medium">{endTarget.status}</span>. This
                  action does not disconnect Google, suspend campaigns or change who pays Google.
                </p>
              </div>

              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--danger-red)]/25 bg-[var(--danger-red)]/10 p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                <ShieldOff className="mt-0.5 size-4 shrink-0 text-[var(--danger-red)]" />
                <p>
                  The boundary cannot be edited, deleted or reopened from this dashboard. If the
                  live Google capture fails or no longer matches the opening evidence, billing
                  stays active.
                </p>
              </div>

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-subtle)] p-3 transition-smooth hover:border-[var(--border-strong)]">
                <Checkbox
                  checked={endConfirmed}
                  onCheckedChange={(checked) => setEndConfirmed(checked === true)}
                  className="mt-0.5"
                  aria-label="Confirm permanent Google billing end"
                />
                <span className="text-[12.5px] leading-relaxed text-[var(--text-primary)]">
                  I understand that this permanently closes agency billing for this Google Ads
                  account at the Google-reported counter captured now, and that Google reporting
                  can arrive later.
                </span>
              </label>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(busy)}
              onClick={() => {
                setEndTarget(null);
                setEndConfirmed(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={Boolean(endTarget && busy === `end-google-${endTarget.id}`)}
              disabled={!endConfirmed || Boolean(busy) || billingBoundaryAuditFailed}
              onClick={terminateGoogle}
            >
              <ShieldOff />
              Capture counter &amp; stop billing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
