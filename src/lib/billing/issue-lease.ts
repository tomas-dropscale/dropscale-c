import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingIssueLease, Database } from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

export type BillingIssueLeaseHandle = {
  clientId: string;
  leaseToken: string;
  fencingToken: number;
  periodStart: string;
  issuedBy: string | null;
  leaseExpiresAt: string;
};

export class BillingIssueLeaseServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingIssueLeaseServiceError";
  }
}

/** Ownership could not be proved, so the caller must stop every mutation. */
export class BillingIssueLeaseLostError extends Error {
  constructor(
    message = "The billing issue lease is no longer owned by this attempt.",
  ) {
    super(message);
    this.name = "BillingIssueLeaseLostError";
  }
}

function parseLease(
  value: BillingIssueLease,
  expected: {
    clientId: string;
    leaseToken: string;
    periodStart?: string;
    issuedBy?: string | null;
    fencingToken?: number;
  },
): BillingIssueLeaseHandle {
  if (
    value.client_id !== expected.clientId ||
    value.lease_token !== expected.leaseToken ||
    (expected.periodStart !== undefined &&
      value.period_start !== expected.periodStart) ||
    (expected.issuedBy !== undefined &&
      value.issued_by !== expected.issuedBy) ||
    (expected.fencingToken !== undefined &&
      value.fencing_token !== expected.fencingToken) ||
    !Number.isSafeInteger(value.fencing_token) ||
    value.fencing_token <= 0 ||
    value.released_at !== null ||
    !value.lease_expires_at
  ) {
    throw new BillingIssueLeaseServiceError(
      "The billing lease service returned an invalid generation.",
    );
  }

  return {
    clientId: value.client_id,
    leaseToken: value.lease_token,
    fencingToken: value.fencing_token,
    periodStart: value.period_start,
    issuedBy: value.issued_by,
    leaseExpiresAt: value.lease_expires_at,
  };
}

function singleLease(
  rows: BillingIssueLease[] | null,
): BillingIssueLease | null {
  if (!rows || rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new BillingIssueLeaseServiceError(
      "The billing lease service returned more than one generation.",
    );
  }
  return rows[0];
}

/**
 * Acquire the only active Stripe-issue lease for a portal client.
 *
 * A transport failure is retried once with the same UUID. The SQL contract
 * treats that exact replay idempotently, which covers a committed RPC whose
 * HTTP response was lost without ever minting a second fence generation.
 */
export async function acquireBillingIssueLease(
  supabase: Supabase,
  input: {
    clientId: string;
    periodStart: string;
    issuedBy: string | null;
    leaseToken?: string;
  },
): Promise<BillingIssueLeaseHandle | null> {
  const leaseToken = input.leaseToken ?? crypto.randomUUID();
  const args = {
    p_client_id: input.clientId,
    p_lease_token: leaseToken,
    p_period_start: input.periodStart,
    p_issued_by: input.issuedBy,
  };

  let result = await supabase.rpc("acquire_billing_issue_lease", args);
  if (result.error) {
    result = await supabase.rpc("acquire_billing_issue_lease", args);
  }
  if (result.error) {
    throw new BillingIssueLeaseServiceError(
      `Could not acquire the billing issue lease: ${result.error.message}`,
    );
  }

  const row = singleLease(result.data);
  return row
    ? parseLease(row, {
        clientId: input.clientId,
        leaseToken,
        periodStart: input.periodStart,
        issuedBy: input.issuedBy,
      })
    : null;
}

/** Renew and fence-check immediately beside a Stripe mutation. */
export async function renewBillingIssueLease(
  supabase: Supabase,
  lease: BillingIssueLeaseHandle,
): Promise<void> {
  const args = {
    p_client_id: lease.clientId,
    p_lease_token: lease.leaseToken,
    p_fencing_token: lease.fencingToken,
  };

  let result = await supabase.rpc("renew_billing_issue_lease", args);
  if (result.error) {
    result = await supabase.rpc("renew_billing_issue_lease", args);
  }
  if (result.error) {
    throw new BillingIssueLeaseLostError(
      `Billing issue lease renewal failed: ${result.error.message}`,
    );
  }

  const row = singleLease(result.data);
  if (!row) throw new BillingIssueLeaseLostError();
  parseLease(row, {
    clientId: lease.clientId,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
  });
}

/** Idempotently release only the still-current fence generation. */
export async function releaseBillingIssueLease(
  supabase: Supabase,
  lease: BillingIssueLeaseHandle,
): Promise<boolean> {
  const args = {
    p_client_id: lease.clientId,
    p_lease_token: lease.leaseToken,
    p_fencing_token: lease.fencingToken,
  };

  let result = await supabase.rpc("release_billing_issue_lease", args);
  if (result.error) {
    result = await supabase.rpc("release_billing_issue_lease", args);
  }
  if (result.error) {
    throw new BillingIssueLeaseServiceError(
      `Could not release the billing issue lease: ${result.error.message}`,
    );
  }
  if (typeof result.data !== "boolean") {
    throw new BillingIssueLeaseServiceError(
      "The billing lease service returned an invalid release result.",
    );
  }
  return result.data;
}

/**
 * Atomically fence-check and annotate a recoverable invoice.
 *
 * False means this generation no longer owns the client (or delivery already
 * completed), so a delayed worker must leave the newer attempt untouched.
 */
export async function recordBillingIssueError(
  supabase: Supabase,
  lease: BillingIssueLeaseHandle,
  invoiceId: string,
  issueError: string,
): Promise<boolean> {
  const args = {
    p_client_id: lease.clientId,
    p_lease_token: lease.leaseToken,
    p_fencing_token: lease.fencingToken,
    p_invoice_id: invoiceId,
    p_issue_error: issueError.slice(0, 1000),
  };

  let result = await supabase.rpc("record_billing_issue_error", args);
  if (result.error) {
    result = await supabase.rpc("record_billing_issue_error", args);
  }
  if (result.error) {
    throw new BillingIssueLeaseServiceError(
      `Could not record the fenced billing issue error: ${result.error.message}`,
    );
  }
  if (typeof result.data !== "boolean") {
    throw new BillingIssueLeaseServiceError(
      "The billing lease service returned an invalid issue-error result.",
    );
  }
  return result.data;
}
