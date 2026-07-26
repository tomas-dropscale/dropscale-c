-- =============================================================================
-- 0012 — HST settlements.
--
-- The HST commission LEDGER is fully auto-synced: every sync republishes the
-- rows from the ERP, so nothing hand-edited on those rows can survive. What
-- HST has actually PAID us is therefore recorded here instead — one row per
-- payment received, entered by an admin when the money lands.
--
-- `covers_through` is what ties a payment back to the ledger: every commission
-- day up to that date counts as settled. The sync re-derives each row's status
-- from these rows (paid vs confirmed), so the payment state survives being
-- republished — it is computed, never stored on the commission itself.
-- =============================================================================

create table if not exists public.hst_payments (
  id uuid primary key default gen_random_uuid(),
  -- The day the money landed.
  paid_on date not null default current_date,
  amount numeric(12,2) not null check (amount >= 0),
  -- Commission days up to and including this one are settled by this payment.
  covers_through date not null,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists hst_payments_covers_through_idx
  on public.hst_payments (covers_through desc);

alter table public.hst_payments enable row level security;

drop policy if exists hst_payments_admin_all on public.hst_payments;
create policy hst_payments_admin_all on public.hst_payments
  for all using (public.is_admin()) with check (public.is_admin());
