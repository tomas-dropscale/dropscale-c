-- =============================================================================
-- 0013 — Client billing through Stripe.
--
-- One invoice per client per WEEK (Monday→Sunday), covering the agency
-- commission booked for that client's ad accounts in that period. The row here
-- is the source of truth for WHAT was billed; Stripe owns payment state, and
-- the webhook writes it back.
--
-- (client_id, period_start) is the idempotency key: the generator runs lazily
-- on page loads — this stack has no cron — so it must be safe to attempt the
-- same week any number of times.
-- =============================================================================

-- Stripe's customer for a portal client, created on first invoice.
alter table public.portal_clients
  add column if not exists stripe_customer_id text;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id) on delete cascade,

  -- Inclusive billing window. Monday → Sunday.
  period_start date not null,
  period_end date not null,

  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'EUR',

  -- draft  → created here, not yet in Stripe
  -- open   → finalised in Stripe, payable
  -- paid   → settled
  -- void / uncollectible → written off
  status text not null default 'draft'
    check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  due_date date,

  -- What the amount is made of: [{ label, amount, accountId }]. A snapshot, so
  -- an invoice always shows what was billed even if a store is renamed later.
  line_items jsonb not null default '[]'::jsonb,

  stripe_invoice_id text unique,
  stripe_hosted_url text,

  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (client_id, period_start)
);

create index if not exists invoices_client_idx on public.invoices (client_id, period_start desc);
create index if not exists invoices_status_idx on public.invoices (status);

alter table public.invoices enable row level security;

-- Clients read their own; only admins write. Payment state never comes from a
-- browser — it comes from the Stripe webhook, which runs with admin rights.
drop policy if exists invoices_client_read on public.invoices;
create policy invoices_client_read on public.invoices
  for select using (client_id = auth.uid() or public.is_admin());

drop policy if exists invoices_admin_all on public.invoices;
create policy invoices_admin_all on public.invoices
  for all using (public.is_admin()) with check (public.is_admin());
