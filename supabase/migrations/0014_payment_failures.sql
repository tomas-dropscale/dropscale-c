-- =============================================================================
-- 0014 — remember when a charge failed.
--
-- An automatic charge can fail for reasons the client alone can fix: an expired
-- card, no funds, or — the common one in Europe — a bank demanding 3-D Secure
-- for an off-session payment. Stripe reports every one of those as
-- `invoice.payment_failed`, and until now the webhook only pushed the invoice
-- back to 'open'. That is indistinguishable from an invoice nobody has paid
-- yet, so neither the client nor the agency was ever told a charge had been
-- attempted and refused.
--
-- Status stays as it was: an invoice whose charge failed is still open and
-- still owed. This column records the ATTEMPT, and is cleared on payment so a
-- healed invoice stops warning.
-- =============================================================================

alter table public.invoices
  add column if not exists payment_failed_at timestamptz;

-- Partial: the interesting set is always "currently failing", which is a small
-- slice of the table, and both the client's Payments tab and the admin clients
-- list filter on exactly this.
create index if not exists invoices_payment_failed_idx
  on public.invoices (client_id)
  where payment_failed_at is not null;
