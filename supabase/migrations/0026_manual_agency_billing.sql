-- =============================================================================
-- 0026 - Manual, review-first agency billing.
--
-- Clients pay Google directly. A Dropscale invoice contains only the fixed 10%
-- agency fee, is always EUR, and is issued only by an explicit admin action.
-- Existing invoices are preserved and labelled as legacy snapshots.
-- =============================================================================

alter table public.invoices
  add column if not exists stripe_invoice_number text,
  add column if not exists stripe_invoice_pdf text,
  add column if not exists amount_remaining numeric(12,2),
  add column if not exists issue_error text,
  add column if not exists issue_attempted_at timestamptz,
  add column if not exists issued_by uuid references public.profiles (id) on delete set null,
  add column if not exists calculation_version text not null default 'legacy';

-- Google reports cost in integer micros. Preserve all six decimal places in
-- the authoritative ledger: rounding each day to cents before summing can
-- move a weekly base/fee across a cent boundary.
alter table public.commissions
  alter column gross_amount type numeric(18,6)
    using round(gross_amount::numeric, 6),
  alter column amount type numeric(18,6)
    using round(amount::numeric, 6);

-- A client carrying financial history must be revoked/soft-disabled, not
-- deleted. Otherwise the original ON DELETE CASCADE would erase invoices and
-- reopen their unique client/week keys.
alter table public.invoices
  drop constraint if exists invoices_client_id_fkey;
alter table public.invoices
  add constraint invoices_client_id_fkey
  foreign key (client_id) references public.portal_clients (id) on delete restrict;

comment on column public.invoices.amount_remaining is
  'Stripe amount_remaining converted to major currency units; authoritative for open balances.';
comment on column public.invoices.issue_error is
  'Last manual issue error. A draft with an error may be safely retried against the same Stripe id.';
comment on column public.invoices.calculation_version is
  'Immutable commercial formula. New manual invoices use agency-fee-eur-10-v2-google-baseline.';

-- Financial rows are append-only from every browser session. Stripe identity,
-- issue attempts and payment state are written only by authenticated server
-- routes using the service role; otherwise a compromised admin session could
-- fabricate `paid` or race Stripe into a permanently divergent local state.
-- New rows are created only through the validated SECURITY DEFINER RPC below.
drop policy if exists invoices_admin_all on public.invoices;
drop policy if exists invoices_admin_insert on public.invoices;
drop policy if exists invoices_admin_update on public.invoices;

create or replace function public.guard_invoice_commercial_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.client_id is distinct from old.client_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.line_items is distinct from old.line_items
     or new.issued_by is distinct from old.issued_by
     or new.calculation_version is distinct from old.calculation_version
     or new.created_at is distinct from old.created_at then
    raise exception 'An invoice commercial snapshot is immutable.';
  end if;

  if old.stripe_invoice_id is not null
     and new.stripe_invoice_id is distinct from old.stripe_invoice_id then
    raise exception 'A Stripe invoice link cannot be replaced.';
  end if;

  return new;
end
$$;

drop trigger if exists invoices_guard_commercial_snapshot on public.invoices;
create trigger invoices_guard_commercial_snapshot
  before update on public.invoices
  for each row execute function public.guard_invoice_commercial_snapshot();

-- The broad legacy self-update policies are needed for ordinary profile and
-- account settings, so protect the billing-sensitive columns with guards.
create or replace function public.guard_portal_client_stripe_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.stripe_customer_id is not null
     and new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'A Stripe customer binding cannot be replaced.';
  end if;

  if new.stripe_customer_id is distinct from old.stripe_customer_id
     and auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can bind a Stripe customer.';
  end if;
  return new;
end
$$;

drop trigger if exists portal_clients_guard_stripe_identity on public.portal_clients;
create trigger portal_clients_guard_stripe_identity
  before update on public.portal_clients
  for each row execute function public.guard_portal_client_stripe_identity();

-- Google accepts the familiar 123-456-7890 presentation, but billing needs a
-- single canonical identity. Without normalisation the same customer could be
-- attached twice using different punctuation and its spend charged twice.
create or replace function public.normalize_google_ads_customer_id(p_value text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select nullif(regexp_replace(trim(p_value), '[^0-9]', '', 'g'), '')
$$;

-- Fail before the unique index with the row and value that need attention.
-- Letters are rejected rather than silently stripped; spaces and hyphens are
-- the only non-digit characters Google commonly uses for display.
do $$
declare
  invalid_account uuid;
  invalid_value text;
  duplicate_customer text;
begin
  select account.id, account.google_ads_customer_id
    into invalid_account, invalid_value
  from public.ad_accounts account
  where account.google_ads_customer_id is not null
    and (
      account.google_ads_customer_id !~ '^[0-9[:space:]-]+$'
      or length(public.normalize_google_ads_customer_id(account.google_ads_customer_id)) <> 10
    )
  limit 1;

  if invalid_account is not null then
    raise exception
      'Cannot protect Google billing identities: ad account % has invalid customer id "%" (expected 10 digits).',
      invalid_account,
      invalid_value;
  end if;

  select public.normalize_google_ads_customer_id(account.google_ads_customer_id)
    into duplicate_customer
  from public.ad_accounts account
  where account.google_ads_customer_id is not null
  group by public.normalize_google_ads_customer_id(account.google_ads_customer_id)
  having count(*) > 1
  limit 1;

  if duplicate_customer is not null then
    raise exception
      'Cannot protect Google billing identities: customer % is linked to multiple ad accounts.',
      duplicate_customer;
  end if;
end
$$;

update public.ad_accounts
set google_ads_customer_id = public.normalize_google_ads_customer_id(google_ads_customer_id)
where google_ads_customer_id is not null
  and google_ads_customer_id is distinct from
      public.normalize_google_ads_customer_id(google_ads_customer_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ad_accounts_google_customer_id_format'
      and conrelid = 'public.ad_accounts'::regclass
  ) then
    alter table public.ad_accounts
      add constraint ad_accounts_google_customer_id_format
      check (
        google_ads_customer_id is null
        or google_ads_customer_id ~ '^[0-9]{10}$'
      );
  end if;
end
$$;

create unique index if not exists ad_accounts_google_customer_unique_idx
  on public.ad_accounts (google_ads_customer_id)
  where google_ads_customer_id is not null;

-- Google reports the current local day's cost as a cumulative integer-micros
-- counter. Freeze the value returned when an account becomes billable: the
-- first invoice can then exclude the Google-reported pre-service portion of
-- the opening day without using ad_accounts.created_at as a financial
-- boundary. Google reporting itself may lag event time; captured_at proves
-- when this observed value was read, not that every prior event was present.
-- One account and one capture id can each establish this boundary only once.
create table if not exists public.ad_account_billing_starts (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique
    references public.ad_accounts (id) on delete restrict,
  google_ads_customer_id text not null
    constraint ad_account_billing_starts_google_customer_format
    check (google_ads_customer_id ~ '^[0-9]{10}$'),
  google_local_date date not null,
  google_time_zone text not null
    constraint ad_account_billing_starts_time_zone_present
    check (btrim(google_time_zone) <> ''),
  currency text not null
    constraint ad_account_billing_starts_eur_only
    check (currency = 'EUR'),
  baseline_cost_micros numeric(24,0) not null
    constraint ad_account_billing_starts_baseline_nonnegative
    check (baseline_cost_micros >= 0),
  capture_started_at timestamptz not null,
  captured_at timestamptz not null,
  capture_id uuid not null unique,
  source text not null
    constraint ad_account_billing_starts_source_check
    check (source = 'agency'),
  reviewed_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint ad_account_billing_starts_capture_order
    check (captured_at >= capture_started_at)
);

create index if not exists ad_account_billing_starts_reviewer_idx
  on public.ad_account_billing_starts (reviewed_by, captured_at desc);

alter table public.ad_account_billing_starts enable row level security;

drop policy if exists ad_account_billing_starts_admin_read
  on public.ad_account_billing_starts;
create policy ad_account_billing_starts_admin_read
  on public.ad_account_billing_starts
  for select using (public.is_admin());

-- RLS intentionally exposes no browser write path. This trigger also protects
-- the row from service-role mistakes after the service-only commit RPC has
-- inserted it; corrections require an explicit future compensating workflow.
create or replace function public.guard_ad_account_billing_start_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A Google billing start is immutable.';
end
$$;

drop trigger if exists ad_account_billing_starts_guard_immutable
  on public.ad_account_billing_starts;
create trigger ad_account_billing_starts_guard_immutable
  before update or delete on public.ad_account_billing_starts
  for each row execute function public.guard_ad_account_billing_start_immutable();

-- Ending the commercial service is a separate, explicit Google source read.
-- `suspended` remains a reversible technical pause and therefore deliberately
-- does not create or imply this boundary. The final local day's cumulative
-- counter lets the invoice exclude spend after the service ended without
-- discarding the billable portion of that same day.
create table if not exists public.ad_account_billing_ends (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique
    references public.ad_accounts (id) on delete restrict,
  billing_start_id uuid not null unique
    references public.ad_account_billing_starts (id) on delete restrict,
  google_ads_customer_id text not null
    constraint ad_account_billing_ends_google_customer_format
    check (google_ads_customer_id ~ '^[0-9]{10}$'),
  google_local_date date not null,
  google_time_zone text not null
    constraint ad_account_billing_ends_time_zone_present
    check (btrim(google_time_zone) <> ''),
  currency text not null
    constraint ad_account_billing_ends_eur_only
    check (currency = 'EUR'),
  end_cost_micros numeric(24,0) not null
    constraint ad_account_billing_ends_counter_nonnegative
    check (end_cost_micros >= 0),
  capture_started_at timestamptz not null,
  captured_at timestamptz not null,
  capture_id uuid not null unique,
  source text not null
    constraint ad_account_billing_ends_source_check
    check (source = 'agency'),
  reviewed_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint ad_account_billing_ends_capture_order
    check (captured_at >= capture_started_at)
);

create index if not exists ad_account_billing_ends_reviewer_idx
  on public.ad_account_billing_ends (reviewed_by, captured_at desc);

alter table public.ad_account_billing_ends enable row level security;

drop policy if exists ad_account_billing_ends_admin_read
  on public.ad_account_billing_ends;
create policy ad_account_billing_ends_admin_read
  on public.ad_account_billing_ends
  for select using (public.is_admin());

-- There is intentionally no browser write policy. Even the trusted service
-- cannot edit or delete a committed end after the service-only RPC inserts it.
create or replace function public.guard_ad_account_billing_end_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A Google billing end is immutable.';
end
$$;

drop trigger if exists ad_account_billing_ends_guard_immutable
  on public.ad_account_billing_ends;
create trigger ad_account_billing_ends_guard_immutable
  before update or delete on public.ad_account_billing_ends
  for each row execute function public.guard_ad_account_billing_end_immutable();

create or replace function public.guard_ad_account_billing_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_google_customer_id text := new.google_ads_customer_id;
begin
  if raw_google_customer_id is not null
     and raw_google_customer_id !~ '^[0-9[:space:]-]+$' then
    raise exception 'A Google Ads customer id may contain only digits, spaces and hyphens.';
  end if;

  new.google_ads_customer_id :=
    public.normalize_google_ads_customer_id(raw_google_customer_id);

  if new.google_ads_customer_id is not null
     and new.google_ads_customer_id !~ '^[0-9]{10}$' then
    raise exception 'A Google Ads customer id must contain exactly 10 digits.';
  end if;

  if tg_op = 'INSERT' then
    -- The legacy INSERT policy checked only workspace ownership. Force every
    -- browser-created account through team approval and prevent a caller from
    -- seeding copied OAuth ciphertext, a fake creation date/currency or its
    -- own agency price alongside it.
    if auth.uid() is not null and not public.is_admin() then
      new.status := 'pending';
      new.created_at := now();
      new.currency := 'EUR';
      new.google_ads_refresh_token := null;
      new.google_ads_connected_email := null;
      new.google_ads_connected := false;
      new.list_commission_rate := 10;
      new.commission_rate := public.effective_commission_rate(new.client_id, 10);
      new.revenue_share_enabled := false;
    end if;

    -- A baseline row cannot reference an account that has not been inserted
    -- yet. Consequently every direct INSERT must remain pending; the atomic
    -- service RPC inserts pending, records the baseline and only then activates
    -- it in the same transaction.
    if new.status <> 'pending' then
      raise exception 'An approved Google account requires a committed billing start.';
    end if;
    return new;
  end if;

  if auth.uid() is not null and not public.is_admin() then
    if new.created_at is distinct from old.created_at then
      raise exception 'An ad account creation date is immutable.';
    end if;
    if new.currency is distinct from old.currency then
      raise exception 'Only the team can change an ad account currency.';
    end if;
  end if;

  -- Once the boundary exists, its Google identity and account owner are part
  -- of the immutable commercial evidence even before the first ledger row.
  if exists (
       select 1
       from public.ad_account_billing_starts billing_start
       where billing_start.ad_account_id = old.id
         and (
           new.google_ads_customer_id is distinct from billing_start.google_ads_customer_id
           or new.client_id is distinct from old.client_id
         )
     ) then
    raise exception 'An account with a Google billing start cannot change billing identity or owner.';
  end if;

  -- Pending may become billable only after the start row is durable. Active
  -- and suspended legacy accounts can otherwise be edited while remediation is
  -- pending, but invoice creation below fails closed until they have a start.
  if old.status = 'pending'
     and new.status in ('active', 'suspended')
     and not exists (
       select 1
       from public.ad_account_billing_starts billing_start
       where billing_start.ad_account_id = old.id
     ) then
    raise exception 'An approved Google account requires a committed billing start.';
  end if;

  -- Clients may correct a pending, disconnected request. Once the team has
  -- approved it, the customer id is the billable identity and is frozen for
  -- every authenticated browser, including the admin UI.
  if new.google_ads_customer_id is distinct from old.google_ads_customer_id
     and exists (
       select 1 from public.commissions commission
       where commission.ad_account_id = old.id
     ) then
    raise exception 'A Google billing identity with ledger history cannot be replaced.';
  end if;

  if new.google_ads_customer_id is distinct from old.google_ads_customer_id
     and auth.uid() is not null
     and (
       old.status <> 'pending'
       or new.status <> 'pending'
       or old.google_ads_connected
     ) then
    raise exception 'Disconnect Google first; an approved Google billing identity can only be changed by the server.';
  end if;

  -- Moving an approved account back to pending would make its immutable
  -- service window disappear from the invoice candidate set, even when that
  -- window legitimately contains zero spend. Suspend it instead.
  if old.status <> 'pending'
     and new.status = 'pending'
     and (
       exists (
         select 1 from public.ad_account_billing_starts billing_start
         where billing_start.ad_account_id = old.id
       )
       or exists (
         select 1 from public.commissions commission
         where commission.ad_account_id = old.id
       )
     ) then
    raise exception 'An ad account with a billing boundary or ledger history cannot return to pending.';
  end if;

  -- Once an account has financial history, changing its owner would rewrite
  -- who owes historic spend. This invariant applies to every role; exceptional
  -- maintenance must explicitly disable the trigger in a controlled migration.
  if new.client_id is distinct from old.client_id
     and exists (
       select 1 from public.commissions commission
       where commission.ad_account_id = old.id
     ) then
    raise exception 'An ad account with ledger history cannot be reassigned.';
  end if;

  return new;
end
$$;

drop trigger if exists ad_accounts_guard_billing_identity on public.ad_accounts;
create trigger ad_accounts_guard_billing_identity
  before insert or update on public.ad_accounts
  for each row execute function public.guard_ad_account_billing_identity();

create or replace function public.guard_ad_account_financial_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
       select 1 from public.ad_account_billing_starts billing_start
       where billing_start.ad_account_id = old.id
     ) then
    raise exception 'An account with a Google billing start cannot be deleted.';
  end if;
  if exists (
       select 1 from public.commissions commission
       where commission.ad_account_id = old.id
     ) then
    raise exception 'An ad account with ledger history cannot be deleted.';
  end if;
  return old;
end
$$;

drop trigger if exists ad_accounts_guard_financial_delete on public.ad_accounts;
create trigger ad_accounts_guard_financial_delete
  before delete on public.ad_accounts
  for each row execute function public.guard_ad_account_financial_delete();

-- EUR is enforced by create_manual_invoice below. A table CHECK, even NOT
-- VALID, would also run during a harmless webhook UPDATE and could make an old
-- non-EUR invoice impossible to mark paid.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_amount_remaining_nonnegative'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_amount_remaining_nonnegative
      check (amount_remaining is null or amount_remaining >= 0) not valid;
  end if;
end
$$;

create index if not exists invoices_issued_at_idx
  on public.invoices (issued_at desc)
  where issued_at is not null;
create index if not exists invoices_open_balance_idx
  on public.invoices (client_id, due_date)
  where status = 'open';

-- One Stripe Customer must never become the billing identity for two portal
-- workspaces. Abort with a useful diagnosis rather than letting CREATE INDEX
-- fail with an opaque duplicate-key message.
do $$
declare
  duplicate_customer text;
begin
  select stripe_customer_id
    into duplicate_customer
  from public.portal_clients
  where stripe_customer_id is not null
  group by stripe_customer_id
  having count(*) > 1
  limit 1;

  if duplicate_customer is not null then
    raise exception
      'Cannot enforce unique Stripe customers: customer % is linked to multiple portal clients.',
      duplicate_customer;
  end if;
end
$$;

create unique index if not exists portal_clients_stripe_customer_unique_idx
  on public.portal_clients (stripe_customer_id)
  where stripe_customer_id is not null;

-- The legacy browser RPC accepted an arbitrary Stripe Customer id. Manual
-- billing binds Customers only in the authenticated server issue path.
-- Functions grant EXECUTE to PUBLIC by default. Revoking only from the named
-- login roles would leave this SECURITY DEFINER RPC callable through their
-- inherited PUBLIC privilege.
revoke all on function public.set_workspace_stripe_customer(uuid, text)
  from public, authenticated, anon;

-- The snapshot in invoices.line_items explains the amount. This junction is
-- the complementary consumption record: UNIQUE(commission_id) makes it
-- impossible to charge the same Google ledger row to a second client after an
-- account is reassigned.
create table if not exists public.invoice_commission_rows (
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  commission_id uuid not null unique references public.commissions (id) on delete restrict,
  -- Google reports cost in micros; keep that precision for audit evidence.
  -- gross_amount is the raw Google value. The deductions prove both immutable
  -- counters were applied once, and what remained inside the service window.
  gross_amount numeric(18,6) not null check (gross_amount >= 0),
  billing_start_id uuid
    references public.ad_account_billing_starts (id) on delete restrict,
  baseline_deduction_amount numeric(18,6),
  billing_end_id uuid
    references public.ad_account_billing_ends (id) on delete restrict,
  end_deduction_amount numeric(18,6),
  billable_gross_amount numeric(18,6),
  currency text not null check (upper(currency) = 'EUR'),
  created_at timestamptz not null default now(),
  primary key (invoice_id, commission_id),
  constraint invoice_commission_rows_v2_evidence_check check (
    (
      billing_start_id is null
      and baseline_deduction_amount is null
      and billing_end_id is null
      and end_deduction_amount is null
      and billable_gross_amount is null
    )
    or
    (
      billing_start_id is not null
      and baseline_deduction_amount is not null
      and billable_gross_amount is not null
      and baseline_deduction_amount >= 0
      and baseline_deduction_amount <= gross_amount
      and (
        (billing_end_id is null and end_deduction_amount is null)
        or
        (
          billing_end_id is not null
          and end_deduction_amount is not null
          and end_deduction_amount >= 0
        )
      )
      and billable_gross_amount >= 0
      and baseline_deduction_amount + coalesce(end_deduction_amount, 0)
            <= gross_amount
      and billable_gross_amount = gross_amount
            - baseline_deduction_amount
            - coalesce(end_deduction_amount, 0)
    )
  )
);

alter table public.invoice_commission_rows
  add column if not exists billing_start_id uuid
    references public.ad_account_billing_starts (id) on delete restrict,
  add column if not exists baseline_deduction_amount numeric(18,6),
  add column if not exists billing_end_id uuid
    references public.ad_account_billing_ends (id) on delete restrict,
  add column if not exists end_deduction_amount numeric(18,6),
  add column if not exists billable_gross_amount numeric(18,6);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_commission_rows_v2_evidence_check'
      and conrelid = 'public.invoice_commission_rows'::regclass
  ) then
    alter table public.invoice_commission_rows
      add constraint invoice_commission_rows_v2_evidence_check check (
        (
          billing_start_id is null
          and baseline_deduction_amount is null
          and billing_end_id is null
          and end_deduction_amount is null
          and billable_gross_amount is null
        )
        or
        (
          billing_start_id is not null
          and baseline_deduction_amount is not null
          and billable_gross_amount is not null
          and baseline_deduction_amount >= 0
          and baseline_deduction_amount <= gross_amount
          and (
            (billing_end_id is null and end_deduction_amount is null)
            or
            (
              billing_end_id is not null
              and end_deduction_amount is not null
              and end_deduction_amount >= 0
            )
          )
          and billable_gross_amount >= 0
          and baseline_deduction_amount + coalesce(end_deduction_amount, 0)
                <= gross_amount
          and billable_gross_amount = gross_amount
                - baseline_deduction_amount
                - coalesce(end_deduction_amount, 0)
        )
      );
  end if;
end
$$;

create index if not exists invoice_commission_rows_invoice_idx
  on public.invoice_commission_rows (invoice_id);

alter table public.invoice_commission_rows enable row level security;

drop policy if exists invoice_commission_rows_admin_read on public.invoice_commission_rows;
create policy invoice_commission_rows_admin_read on public.invoice_commission_rows
  for select using (public.is_admin());

drop policy if exists invoice_commission_rows_admin_insert on public.invoice_commission_rows;

-- A successful Google read has to be recorded even when the whole period is
-- zero (zero days deliberately do not create financial ledger rows). Billing
-- uses this exact account + period marker to distinguish "confirmed zero" from
-- "this closed week was never refreshed".
create table if not exists public.google_ledger_sync_windows (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  billing_start_id uuid not null
    references public.ad_account_billing_starts (id) on delete restrict,
  -- Null until a commercial end exists. The final week's proof must be bound
  -- to that exact immutable counter before it can certify an invoice.
  billing_end_id uuid
    references public.ad_account_billing_ends (id) on delete restrict,
  period_start date not null,
  period_end date not null,
  -- A generation token prevents an older concurrent refresh from certifying a
  -- window after a newer one has already superseded it.
  run_id uuid not null default gen_random_uuid(),
  status text not null default 'complete'
    constraint google_ledger_sync_windows_status_check
    check (status in ('in_progress', 'complete', 'failed')),
  started_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  -- Exact authoritative rows observed immediately before completion. The
  -- issue RPC compares this with the locked ledger, closing the race where a
  -- different transaction began mutating rows while the marker was running.
  ledger_snapshot jsonb not null default '[]'::jsonb
    constraint google_ledger_sync_windows_snapshot_check
    check (jsonb_typeof(ledger_snapshot) = 'array'),
  primary key (ad_account_id, period_start, period_end),
  check (period_end >= period_start)
);

alter table public.google_ledger_sync_windows
  add column if not exists billing_start_id uuid
    references public.ad_account_billing_starts (id) on delete restrict,
  add column if not exists billing_end_id uuid
    references public.ad_account_billing_ends (id) on delete restrict,
  add column if not exists run_id uuid not null default gen_random_uuid(),
  add column if not exists status text not null default 'complete',
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists ledger_snapshot jsonb not null default '[]'::jsonb;

-- A proof made before the immutable boundary existed cannot certify a v2
-- invoice. Drop such legacy markers instead of guessing which start they
-- belonged to, then make the binding mandatory for every future sync.
delete from public.google_ledger_sync_windows
where billing_start_id is null;

alter table public.google_ledger_sync_windows
  alter column billing_start_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'google_ledger_sync_windows_status_check'
      and conrelid = 'public.google_ledger_sync_windows'::regclass
  ) then
    alter table public.google_ledger_sync_windows
      add constraint google_ledger_sync_windows_status_check
      check (status in ('in_progress', 'complete', 'failed'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'google_ledger_sync_windows_snapshot_check'
      and conrelid = 'public.google_ledger_sync_windows'::regclass
  ) then
    alter table public.google_ledger_sync_windows
      add constraint google_ledger_sync_windows_snapshot_check
      check (jsonb_typeof(ledger_snapshot) = 'array');
  end if;
end
$$;

alter table public.google_ledger_sync_windows enable row level security;

drop policy if exists google_ledger_sync_windows_admin_all
  on public.google_ledger_sync_windows;
drop policy if exists google_ledger_sync_windows_admin_read
  on public.google_ledger_sync_windows;
create policy google_ledger_sync_windows_admin_read
  on public.google_ledger_sync_windows
  for select using (public.is_admin());

-- Any relevant ledger mutation invalidates every completed proof whose date
-- range contains that row. During the sync its own marker is in_progress and
-- remains present; all other overlapping completed windows are revoked. A
-- failed/partial run can therefore never leave the old green marker behind.
create or replace function public.invalidate_google_ledger_windows_for_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT'
     and old.ad_account_id is not null
     and exists (
       select 1 from public.revenue_sources source
       where source.id = old.source_id
         and source.name = 'Google Ads Management'
     ) then
    delete from public.google_ledger_sync_windows sync
    where sync.ad_account_id = old.ad_account_id
      and old.occurred_on between sync.period_start and sync.period_end
      and not exists (
        select 1
        from public.ad_account_billing_ends billing_end
        where billing_end.ad_account_id = old.ad_account_id
          and old.occurred_on > billing_end.google_local_date
      )
      and sync.status = 'complete';
  end if;

  if tg_op <> 'DELETE'
     and new.ad_account_id is not null
     and exists (
       select 1 from public.revenue_sources source
       where source.id = new.source_id
         and source.name = 'Google Ads Management'
     ) then
    delete from public.google_ledger_sync_windows sync
    where sync.ad_account_id = new.ad_account_id
      and new.occurred_on between sync.period_start and sync.period_end
      and not exists (
        select 1
        from public.ad_account_billing_ends billing_end
        where billing_end.ad_account_id = new.ad_account_id
          and new.occurred_on > billing_end.google_local_date
      )
      and sync.status = 'complete';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

drop trigger if exists commissions_invalidate_google_ledger_windows
  on public.commissions;
create trigger commissions_invalidate_google_ledger_windows
  after insert or update or delete on public.commissions
  for each row execute function public.invalidate_google_ledger_windows_for_commission();

-- Identity changes and crossing the pending/approved boundary alter which
-- customer/accounts belong in a bill. Active <-> suspended deliberately keeps
-- a valid closed-week proof: both statuses remain billable. Currency changes
-- made by the sync preserve only the current in-progress proof and invalidate
-- older completed windows.
create or replace function public.invalidate_google_ledger_windows_for_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.google_ads_customer_id is distinct from old.google_ads_customer_id
     or ((new.status = 'pending') is distinct from (old.status = 'pending')) then
    delete from public.google_ledger_sync_windows
    where ad_account_id = old.id;
  elsif new.currency is distinct from old.currency then
    delete from public.google_ledger_sync_windows
    where ad_account_id = old.id
      and status = 'complete';
  end if;
  return new;
end
$$;

drop trigger if exists ad_accounts_invalidate_google_ledger_windows
  on public.ad_accounts;
create trigger ad_accounts_invalidate_google_ledger_windows
  after update on public.ad_accounts
  for each row execute function public.invalidate_google_ledger_windows_for_account();

-- Commit the source-read counter and the status transition as one database
-- transaction. Only the service-role backend can call this function; even an
-- authenticated admin must go through the server path that reads Google live.
-- Exactly one target is accepted: either an existing account (including a
-- legacy active/suspended account missing its boundary) or a pending Google
-- account request that is provisioned and approved here.
create or replace function public.commit_google_ads_billing_start(
  p_account_id uuid,
  p_request_id uuid,
  p_capture_id uuid,
  p_google_ads_customer_id text,
  p_google_local_date date,
  p_google_time_zone text,
  p_currency text,
  p_baseline_cost_micros numeric,
  p_capture_started_at timestamptz,
  p_captured_at timestamptz,
  p_source text,
  p_reviewed_by uuid
)
returns setof public.ad_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account public.ad_accounts%rowtype;
  target_request public.account_requests%rowtype;
  existing_start public.ad_account_billing_starts%rowtype;
  captured_local_date date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the service role can commit a Google billing start.'
      using errcode = '42501';
  end if;

  if (p_account_id is null) = (p_request_id is null) then
    raise exception 'Provide exactly one account or account request.'
      using errcode = '22023';
  end if;

  if p_capture_id is null
     or p_google_ads_customer_id is null
     or p_google_ads_customer_id !~ '^[0-9]{10}$'
     or p_google_local_date is null
     or nullif(btrim(p_google_time_zone), '') is null
     or p_currency is null
     or p_currency <> 'EUR'
     or p_baseline_cost_micros is null
     or p_baseline_cost_micros < 0
     or p_baseline_cost_micros <> trunc(p_baseline_cost_micros)
     or p_capture_started_at is null
     or p_captured_at is null
     or p_captured_at < p_capture_started_at
     or p_source is null
     or p_source <> 'agency'
     or p_reviewed_by is null then
    raise exception 'Invalid authoritative Google billing-start capture.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from pg_timezone_names zone
    where zone.name = p_google_time_zone
  ) then
    raise exception 'The Google billing-start time zone must be a recognised IANA identifier.'
      using errcode = '22023';
  end if;

  -- AT TIME ZONE both validates the IANA identifier and proves the day stored
  -- beside the counter is the Google-local day at the completed read instant.
  captured_local_date := (p_captured_at at time zone p_google_time_zone)::date;
  if captured_local_date <> p_google_local_date then
    raise exception 'The captured Google-local date does not match the capture instant.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_reviewed_by
      and profile.role = 'admin'
  ) then
    raise exception 'The billing-start reviewer must be an admin.'
      using errcode = '22023';
  end if;

  -- Network responses can be lost after COMMIT. The capture UUID makes an
  -- exact retry idempotent, while refusing to replay the same source read with
  -- different evidence or against another target.
  select *
    into existing_start
  from public.ad_account_billing_starts billing_start
  where billing_start.capture_id = p_capture_id
  for update;

  if found then
    if existing_start.google_ads_customer_id <> p_google_ads_customer_id
       or existing_start.google_local_date <> p_google_local_date
       or existing_start.google_time_zone <> p_google_time_zone
       or existing_start.currency <> p_currency
       or existing_start.baseline_cost_micros <> p_baseline_cost_micros
       or existing_start.capture_started_at <> p_capture_started_at
       or existing_start.captured_at <> p_captured_at
       or existing_start.source <> p_source
       or existing_start.reviewed_by <> p_reviewed_by then
      raise exception 'A capture id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    select *
      into strict target_account
    from public.ad_accounts account
    where account.id = existing_start.ad_account_id;

    if p_account_id is not null and target_account.id <> p_account_id then
      raise exception 'The capture id belongs to another ad account.'
        using errcode = '22023';
    elsif p_request_id is not null then
      select *
        into target_request
      from public.account_requests request
      where request.id = p_request_id
      for update;
      if target_request.id is null
         or target_request.status <> 'approved'
         or target_request.request_type <> 'google_ads'
         or target_request.client_id <> target_account.client_id
         or public.normalize_google_ads_customer_id(target_request.google_ads_customer_id)
              <> existing_start.google_ads_customer_id then
        raise exception 'The capture id does not belong to this approved Google request.'
          using errcode = '22023';
      end if;
    end if;

    return next target_account;
    return;
  end if;

  if p_request_id is not null then
    select *
      into target_request
    from public.account_requests request
    where request.id = p_request_id
    for update;

    -- A concurrent exact first call may have committed while this request was
    -- waiting for the request lock. Re-read the idempotency receipt after the
    -- lock so the loser returns the winner's account instead of reporting that
    -- the now-approved request is no longer pending.
    select *
      into existing_start
    from public.ad_account_billing_starts billing_start
    where billing_start.capture_id = p_capture_id
    for update;

    if found then
      if existing_start.google_ads_customer_id <> p_google_ads_customer_id
         or existing_start.google_local_date <> p_google_local_date
         or existing_start.google_time_zone <> p_google_time_zone
         or existing_start.currency <> p_currency
         or existing_start.baseline_cost_micros <> p_baseline_cost_micros
         or existing_start.capture_started_at <> p_capture_started_at
         or existing_start.captured_at <> p_captured_at
         or existing_start.source <> p_source
         or existing_start.reviewed_by <> p_reviewed_by then
        raise exception 'A capture id cannot be replayed with different evidence.'
          using errcode = '22023';
      end if;

      select *
        into strict target_account
      from public.ad_accounts account
      where account.id = existing_start.ad_account_id;

      if not found
         or target_request.status <> 'approved'
         or target_request.request_type <> 'google_ads'
         or target_request.client_id <> target_account.client_id
         or public.normalize_google_ads_customer_id(target_request.google_ads_customer_id)
              <> existing_start.google_ads_customer_id then
        raise exception 'The capture id does not belong to this approved Google request.'
          using errcode = '22023';
      end if;

      return next target_account;
      return;
    end if;

    if target_request.id is null
       or target_request.request_type <> 'google_ads'
       or target_request.status <> 'pending' then
      raise exception 'Only a pending Google Ads account request can be approved.'
        using errcode = '22023';
    end if;

    if public.normalize_google_ads_customer_id(target_request.google_ads_customer_id)
         is distinct from p_google_ads_customer_id then
      raise exception 'The live Google customer does not match the account request.'
        using errcode = '22023';
    end if;

    insert into public.ad_accounts (
      client_id,
      store_name,
      google_ads_customer_id,
      status,
      currency,
      list_commission_rate,
      revenue_share_enabled
    ) values (
      target_request.client_id,
      coalesce(nullif(btrim(target_request.store_name), ''), 'Google Ads account'),
      p_google_ads_customer_id,
      'pending',
      'EUR',
      10,
      false
    )
    returning * into target_account;
  else
    select *
      into target_account
    from public.ad_accounts account
    where account.id = p_account_id
    for update;

    -- Same retry window as the request path above, now serialised by the
    -- existing account row.
    select *
      into existing_start
    from public.ad_account_billing_starts billing_start
    where billing_start.capture_id = p_capture_id
    for update;

    if found then
      if target_account.id is null
         or existing_start.ad_account_id <> target_account.id
         or existing_start.google_ads_customer_id <> p_google_ads_customer_id
         or existing_start.google_local_date <> p_google_local_date
         or existing_start.google_time_zone <> p_google_time_zone
         or existing_start.currency <> p_currency
         or existing_start.baseline_cost_micros <> p_baseline_cost_micros
         or existing_start.capture_started_at <> p_capture_started_at
         or existing_start.captured_at <> p_captured_at
         or existing_start.source <> p_source
         or existing_start.reviewed_by <> p_reviewed_by then
        raise exception 'A capture id cannot be replayed with different evidence.'
          using errcode = '22023';
      end if;

      return next target_account;
      return;
    end if;

    if target_account.id is null or target_account.status not in ('pending', 'active', 'suspended') then
      raise exception 'The target ad account does not exist or cannot be made billable.'
        using errcode = '22023';
    end if;

    if target_account.google_ads_customer_id is distinct from p_google_ads_customer_id then
      raise exception 'The live Google customer does not match the ad account.'
        using errcode = '22023';
    end if;

    if target_account.status <> 'pending'
       and upper(target_account.currency) <> 'EUR' then
      raise exception 'A legacy non-EUR account cannot receive an EUR billing start.'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.ad_account_billing_starts billing_start
    where billing_start.ad_account_id = target_account.id
  ) then
    raise exception 'This ad account already has a different Google billing start.'
      using errcode = '23505';
  end if;

  insert into public.ad_account_billing_starts (
    ad_account_id,
    google_ads_customer_id,
    google_local_date,
    google_time_zone,
    currency,
    baseline_cost_micros,
    capture_started_at,
    captured_at,
    capture_id,
    source,
    reviewed_by
  ) values (
    target_account.id,
    p_google_ads_customer_id,
    p_google_local_date,
    p_google_time_zone,
    'EUR',
    p_baseline_cost_micros,
    p_capture_started_at,
    p_captured_at,
    p_capture_id,
    'agency',
    p_reviewed_by
  );

  -- Pending is the only state advanced by the commit. Legacy active accounts
  -- stay active and, critically, suspended accounts remain suspended.
  update public.ad_accounts account
  set status = case when account.status = 'pending' then 'active' else account.status end,
      currency = 'EUR'
  where account.id = target_account.id
  returning * into target_account;

  delete from public.google_ledger_sync_windows
  where ad_account_id = target_account.id;

  if p_request_id is not null then
    update public.account_requests
    set status = 'approved'
    where id = p_request_id
      and status = 'pending';
    if not found then
      raise exception 'The Google account request changed during approval.'
        using errcode = '40001';
    end if;
  end if;

  return next target_account;
end
$$;

revoke all on function public.commit_google_ads_billing_start(
  uuid, uuid, uuid, text, date, text, text, numeric, timestamptz, timestamptz, text, uuid
) from public, authenticated, anon;
grant execute on function public.commit_google_ads_billing_start(
  uuid, uuid, uuid, text, date, text, text, numeric, timestamptz, timestamptz, text, uuid
) to service_role;

-- Capture the closing Google-local day counter without overloading account
-- status. In particular, active <-> suspended remains reversible and never
-- starts or ends a commercial service window by itself.
create or replace function public.commit_google_ads_billing_end(
  p_account_id uuid,
  p_capture_id uuid,
  p_google_ads_customer_id text,
  p_google_local_date date,
  p_google_time_zone text,
  p_currency text,
  p_end_cost_micros numeric,
  p_capture_started_at timestamptz,
  p_captured_at timestamptz,
  p_source text,
  p_reviewed_by uuid
)
returns setof public.ad_account_billing_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account public.ad_accounts%rowtype;
  billing_start public.ad_account_billing_starts%rowtype;
  existing_end public.ad_account_billing_ends%rowtype;
  committed_end public.ad_account_billing_ends%rowtype;
  captured_local_date date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the service role can commit a Google billing end.'
      using errcode = '42501';
  end if;

  if p_account_id is null
     or p_capture_id is null
     or p_google_ads_customer_id is null
     or p_google_ads_customer_id !~ '^[0-9]{10}$'
     or p_google_local_date is null
     or nullif(btrim(p_google_time_zone), '') is null
     or p_currency is null
     or p_currency <> 'EUR'
     or p_end_cost_micros is null
     or p_end_cost_micros < 0
     or p_end_cost_micros <> trunc(p_end_cost_micros)
     or p_capture_started_at is null
     or p_captured_at is null
     or p_captured_at < p_capture_started_at
     or p_source is null
     or p_source <> 'agency'
     or p_reviewed_by is null then
    raise exception 'Invalid authoritative Google billing-end capture.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from pg_timezone_names zone
    where zone.name = p_google_time_zone
  ) then
    raise exception 'The Google billing-end time zone must be a recognised IANA identifier.'
      using errcode = '22023';
  end if;

  captured_local_date := (p_captured_at at time zone p_google_time_zone)::date;
  if captured_local_date <> p_google_local_date then
    raise exception 'The captured Google-local end date does not match the capture instant.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_reviewed_by
      and profile.role = 'admin'
  ) then
    raise exception 'The billing-end reviewer must be an admin.'
      using errcode = '22023';
  end if;

  -- An exact retry after a lost response is harmless. Reusing the receipt for
  -- another account or changing any evidence is never treated as a retry.
  select *
    into existing_end
  from public.ad_account_billing_ends billing_end
  where billing_end.capture_id = p_capture_id
  for update;

  if found then
    if existing_end.ad_account_id <> p_account_id
       or existing_end.google_ads_customer_id <> p_google_ads_customer_id
       or existing_end.google_local_date <> p_google_local_date
       or existing_end.google_time_zone <> p_google_time_zone
       or existing_end.currency <> p_currency
       or existing_end.end_cost_micros <> p_end_cost_micros
       or existing_end.capture_started_at <> p_capture_started_at
       or existing_end.captured_at <> p_captured_at
       or existing_end.source <> p_source
       or existing_end.reviewed_by <> p_reviewed_by then
      raise exception 'A billing-end capture id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    return next existing_end;
    return;
  end if;

  select *
    into target_account
  from public.ad_accounts account
  where account.id = p_account_id
  for update;

  -- If another exact first call committed while this call waited on the
  -- account, return its immutable receipt. The unique constraints already
  -- prevent duplicate financial boundaries; this makes the retry contract
  -- reliable as well as safe.
  select *
    into existing_end
  from public.ad_account_billing_ends billing_end
  where billing_end.capture_id = p_capture_id
  for update;

  if found then
    if target_account.id is null
       or existing_end.ad_account_id <> p_account_id
       or existing_end.google_ads_customer_id <> p_google_ads_customer_id
       or existing_end.google_local_date <> p_google_local_date
       or existing_end.google_time_zone <> p_google_time_zone
       or existing_end.currency <> p_currency
       or existing_end.end_cost_micros <> p_end_cost_micros
       or existing_end.capture_started_at <> p_capture_started_at
       or existing_end.captured_at <> p_captured_at
       or existing_end.source <> p_source
       or existing_end.reviewed_by <> p_reviewed_by then
      raise exception 'A billing-end capture id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    return next existing_end;
    return;
  end if;

  if target_account.id is null or target_account.status not in ('active', 'suspended') then
    raise exception 'Only an active or technically suspended account can end billing.'
      using errcode = '22023';
  end if;

  select *
    into billing_start
  from public.ad_account_billing_starts start_row
  where start_row.ad_account_id = target_account.id
  for share;

  if not found then
    raise exception 'A Google billing end requires an immutable billing start.'
      using errcode = '22023';
  end if;

  if target_account.google_ads_customer_id is distinct from p_google_ads_customer_id
     or billing_start.google_ads_customer_id <> p_google_ads_customer_id
     or upper(target_account.currency) <> 'EUR'
     or billing_start.currency <> p_currency
     or billing_start.google_time_zone <> p_google_time_zone then
    raise exception 'The live Google billing-end identity does not match the immutable start.'
      using errcode = '22023';
  end if;

  -- Google can restate a same-day cost counter downwards (for example after
  -- invalid-click adjustments). A closing counter below the opening baseline
  -- is therefore valid evidence and bills zero via max(end - start, 0); only
  -- the temporal ordering itself is required to be monotonic.
  if p_google_local_date < billing_start.google_local_date
     or p_capture_started_at < billing_start.captured_at
     or p_captured_at < billing_start.captured_at then
    raise exception 'A Google billing end cannot precede its billing start.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.ad_account_billing_ends billing_end
    where billing_end.ad_account_id = target_account.id
  ) then
    raise exception 'This ad account already has a different Google billing end; billing cannot restart silently.'
      using errcode = '23505';
  end if;

  insert into public.ad_account_billing_ends (
    ad_account_id,
    billing_start_id,
    google_ads_customer_id,
    google_local_date,
    google_time_zone,
    currency,
    end_cost_micros,
    capture_started_at,
    captured_at,
    capture_id,
    source,
    reviewed_by
  ) values (
    target_account.id,
    billing_start.id,
    p_google_ads_customer_id,
    p_google_local_date,
    p_google_time_zone,
    'EUR',
    p_end_cost_micros,
    p_capture_started_at,
    p_captured_at,
    p_capture_id,
    'agency',
    p_reviewed_by
  )
  returning * into committed_end;

  -- Any proof covering the final day or a later day was calculated before the
  -- new cap existed. Earlier closed periods are unaffected and remain valid.
  delete from public.google_ledger_sync_windows sync
  where sync.ad_account_id = target_account.id
    and sync.period_end >= committed_end.google_local_date;

  return next committed_end;
end
$$;

revoke all on function public.commit_google_ads_billing_end(
  uuid, uuid, text, date, text, text, numeric, timestamptz, timestamptz, text, uuid
) from public, authenticated, anon;
grant execute on function public.commit_google_ads_billing_end(
  uuid, uuid, text, date, text, text, numeric, timestamptz, timestamptz, text, uuid
) to service_role;

-- One authoritative rowset owns both counter boundaries. Deductions are
-- allocated deterministically across same-day rows, so neither the opening
-- baseline nor the closing cap can be multiplied by joins or reimplemented
-- differently by the line validator and immutable claim writer.
create or replace function public.manual_invoice_authoritative_rows(
  p_client_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  commission_id uuid,
  account_id uuid,
  store_name text,
  occurred_on date,
  currency text,
  billing_start_id uuid,
  billing_start_date date,
  billing_started_at timestamptz,
  billing_time_zone text,
  billing_start_baseline_micros numeric,
  opening_baseline_applied boolean,
  billing_end_id uuid,
  billing_end_date date,
  billing_ended_at timestamptz,
  billing_end_time_zone text,
  billing_end_counter_micros numeric,
  ending_cap_applied boolean,
  source_gross_micros numeric,
  baseline_deduction_micros numeric,
  end_deduction_micros numeric,
  billable_gross_micros numeric,
  source_gross_amount numeric,
  baseline_deduction_amount numeric,
  end_deduction_amount numeric,
  billable_gross_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with measured as (
    select
      commission.id as commission_id,
      account.id as account_id,
      account.store_name,
      commission.occurred_on,
      upper(commission.currency) as currency,
      billing_start.id as billing_start_id,
      billing_start.google_local_date as billing_start_date,
      billing_start.captured_at as billing_started_at,
      billing_start.google_time_zone as billing_time_zone,
      billing_start.baseline_cost_micros as billing_start_baseline_micros,
      billing_start.google_local_date between p_period_start and p_period_end
        as opening_baseline_applied,
      case
        when billing_end.google_local_date between p_period_start and p_period_end
          then billing_end.id
      end as billing_end_id,
      case
        when billing_end.google_local_date between p_period_start and p_period_end
          then billing_end.google_local_date
      end as billing_end_date,
      case
        when billing_end.google_local_date between p_period_start and p_period_end
          then billing_end.captured_at
      end as billing_ended_at,
      case
        when billing_end.google_local_date between p_period_start and p_period_end
          then billing_end.google_time_zone
      end as billing_end_time_zone,
      case
        when billing_end.google_local_date between p_period_start and p_period_end
          then billing_end.end_cost_micros
      end as billing_end_counter_micros,
      coalesce(
        billing_end.google_local_date between p_period_start and p_period_end,
        false
      ) as ending_cap_applied,
      round(commission.gross_amount * 1000000, 0) as source_gross_micros,
      coalesce(
        sum(round(commission.gross_amount * 1000000, 0)) over (
          partition by account.id, commission.occurred_on
          order by commission.id
          rows between unbounded preceding and 1 preceding
        ),
        0
      ) as preceding_day_micros
    from public.commissions commission
    join public.revenue_sources source
      on source.id = commission.source_id
    join public.ad_accounts account
      on account.id = commission.ad_account_id
    join public.ad_account_billing_starts billing_start
      on billing_start.ad_account_id = account.id
     and billing_start.google_ads_customer_id = account.google_ads_customer_id
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = account.id
     and billing_end.billing_start_id = billing_start.id
     and billing_end.google_ads_customer_id = billing_start.google_ads_customer_id
     and billing_end.google_time_zone = billing_start.google_time_zone
     and billing_end.currency = billing_start.currency
    where source.name = 'Google Ads Management'
      and commission.status = 'confirmed'
      and account.client_id = p_client_id
      and account.status in ('active', 'suspended')
      and upper(account.currency) = 'EUR'
      and upper(commission.currency) = 'EUR'
      and commission.gross_amount >= 0
      and commission.occurred_on between
        greatest(p_period_start, billing_start.google_local_date)
        and least(
          p_period_end,
          coalesce(billing_end.google_local_date, p_period_end)
        )
  ), capped as (
    select
      measured.*,
      case
        when measured.occurred_on = measured.billing_end_date
             and measured.ending_cap_applied
          then least(
            measured.source_gross_micros,
            greatest(
              measured.billing_end_counter_micros - measured.preceding_day_micros,
              0
            )
          )
        else measured.source_gross_micros
      end as service_window_source_micros
    from measured
  ), allocated as (
    select
      capped.*,
      case
        when capped.occurred_on = capped.billing_start_date
             and capped.opening_baseline_applied
          then least(
            capped.service_window_source_micros,
            greatest(
              capped.billing_start_baseline_micros - capped.preceding_day_micros,
              0
            )
          )
        else 0
      end as baseline_deduction_micros
    from capped
  )
  select
    allocated.commission_id,
    allocated.account_id,
    allocated.store_name,
    allocated.occurred_on,
    allocated.currency,
    allocated.billing_start_id,
    allocated.billing_start_date,
    allocated.billing_started_at,
    allocated.billing_time_zone,
    allocated.billing_start_baseline_micros,
    allocated.opening_baseline_applied,
    allocated.billing_end_id,
    allocated.billing_end_date,
    allocated.billing_ended_at,
    allocated.billing_end_time_zone,
    allocated.billing_end_counter_micros,
    allocated.ending_cap_applied,
    allocated.source_gross_micros,
    allocated.baseline_deduction_micros,
    allocated.source_gross_micros - allocated.service_window_source_micros,
    allocated.service_window_source_micros - allocated.baseline_deduction_micros,
    allocated.source_gross_micros / 1000000,
    allocated.baseline_deduction_micros / 1000000,
    (allocated.source_gross_micros - allocated.service_window_source_micros) / 1000000,
    (allocated.service_window_source_micros - allocated.baseline_deduction_micros) / 1000000
  from allocated
$$;

revoke all on function public.manual_invoice_authoritative_rows(uuid, date, date)
  from public, authenticated, anon;

-- Invoice creation and ledger-row consumption are one transaction. Existing
-- invoice rows remain untouched; every new call is validated and recorded as
-- v2 Google-baseline evidence without changing the public RPC signature.
create or replace function public.create_manual_invoice(
  p_client_id uuid,
  p_period_start date,
  p_period_end date,
  p_amount numeric,
  p_line_items jsonb,
  p_ledger_rows jsonb,
  p_issued_by uuid,
  p_calculation_version text
)
returns setof public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  created_invoice public.invoices;
  requested_rows integer;
  valid_rows integer;
  expected_rows integer;
  expected_lines integer;
  valid_lines integer;
  distinct_line_accounts integer;
  client_count integer;
  missing_start_count integer;
  legacy_terms_count integer;
  account_count integer;
  ready_account_count integer;
  lines_total numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can create a manual invoice.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required to create a manual invoice.'
      using errcode = '42501';
  end if;

  -- Serialize every table that can alter eligibility, proof or arithmetic.
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.commissions in share row exclusive mode;
  lock table public.google_ledger_sync_windows in share row exclusive mode;

  if p_period_end <> p_period_start + 6 then
    raise exception 'A billing period must be one Monday-to-Sunday week.'
      using errcode = '22023';
  end if;

  if extract(isodow from p_period_start) <> 1 or p_period_end >= current_date then
    raise exception 'Only a fully closed Monday-to-Sunday week can be invoiced.'
      using errcode = '22023';
  end if;

  if p_amount is null
     or p_amount <> round(p_amount, 2)
     or p_amount < 0.01
     or p_calculation_version <> 'agency-fee-eur-10-v2-google-baseline' then
    raise exception 'Invalid manual agency-fee calculation.'
      using errcode = '22023';
  end if;

  select count(*)
    into client_count
  from public.portal_clients client
  where client.id = p_client_id
    and client.approval_status in ('approved', 'rejected')
    and not exists (
      select 1
      from public.profiles profile
      where profile.id = client.id and profile.role = 'admin'
    );

  if client_count <> 1 then
    raise exception 'Only a billable, non-admin portal client can be invoiced.'
      using errcode = '22023';
  end if;

  -- An active/suspended account without a boundary is unresolved legacy data.
  -- Never infer a date from created_at and never invoice around that account.
  select count(*)
    into missing_start_count
  from public.ad_accounts account
  left join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.id is null;

  if missing_start_count <> 0 then
    raise exception 'Every approved account needs a verified Google billing start.'
      using errcode = '22023';
  end if;

  -- The v2 contract is exactly 10% with no revenue share. Old referral and
  -- custom-rate fields are deliberately NOT used in the calculation, but they
  -- still represent a promise the product may have shown to the client. Block
  -- rather than silently charging 10% until those terms are resolved.
  select count(*)
    into legacy_terms_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.google_local_date <= p_period_end
    and (
      billing_end.id is null
      or billing_end.google_local_date >= p_period_start
    )
    and (
      account.commission_rate <> 10
      or account.list_commission_rate <> 10
      or account.revenue_share_enabled
    );

  if legacy_terms_count <> 0 then
    raise exception 'Legacy discount, custom-rate or revenue-share terms must be resolved before a fixed 10%% invoice can be issued.'
      using errcode = '22023';
  end if;

  -- A sync proof is useful only when it is bound to this immutable start and
  -- its canonical six-decimal string snapshot still equals the locked raw
  -- Google ledger. Accounts whose boundary is after this week are not yet part
  -- of the period; no created_at approximation is used anywhere.
  select
    count(*),
    count(*) filter (
      where upper(account.currency) = 'EUR'
        and billing_start.currency = 'EUR'
        and billing_start.google_ads_customer_id = account.google_ads_customer_id
        and not exists (
          select 1
          from public.commissions invalid_commission
          join public.revenue_sources invalid_source
            on invalid_source.id = invalid_commission.source_id
          where invalid_commission.ad_account_id = account.id
            and invalid_source.name = 'Google Ads Management'
            and invalid_commission.status = 'confirmed'
            and invalid_commission.occurred_on between
              greatest(p_period_start, billing_start.google_local_date)
              and least(
                p_period_end,
                coalesce(billing_end.google_local_date, p_period_end)
              )
            and (
              upper(invalid_commission.currency) <> 'EUR'
              or invalid_commission.gross_amount < 0
            )
        )
        and exists (
          select 1
          from public.google_ledger_sync_windows sync
          where sync.ad_account_id = account.id
            and sync.billing_start_id = billing_start.id
            and (
              sync.billing_end_id is not distinct from billing_end.id
              or (
                billing_end.google_local_date > p_period_end
                and sync.billing_end_id is null
              )
            )
            and sync.period_start = p_period_start
            and sync.period_end = p_period_end
            and sync.status = 'complete'
            and (sync.synced_at at time zone billing_start.google_time_zone)::date
                  > p_period_end
            and sync.ledger_snapshot = (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id', commission.id::text,
                    'occurred_on', commission.occurred_on::text,
                    'gross_amount',
                      to_char(
                        commission.gross_amount,
                        'FM999999999999999990.000000'
                      ),
                    'currency', upper(commission.currency),
                    'status', commission.status
                  ) order by commission.id
                ),
                '[]'::jsonb
              )
              from public.commissions commission
              join public.revenue_sources source
                on source.id = commission.source_id
              where commission.ad_account_id = account.id
                and source.name = 'Google Ads Management'
                and commission.status = 'confirmed'
                and commission.occurred_on between
                  greatest(p_period_start, billing_start.google_local_date)
                  and least(
                    p_period_end,
                    coalesce(billing_end.google_local_date, p_period_end)
                  )
            )
        )
    )
    into account_count, ready_account_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.google_local_date <= p_period_end
    and (
      billing_end.id is null
      or billing_end.google_local_date >= p_period_start
    );

  if account_count = 0 then
    raise exception 'No client account had begun billing in this week.'
      using errcode = '22023';
  end if;

  if ready_account_count <> account_count then
    raise exception 'Every client account must be EUR and refreshed for the closed week.'
      using errcode = '22023';
  end if;

  if p_line_items is null
     or jsonb_typeof(p_line_items) <> 'array'
     or p_ledger_rows is null
     or jsonb_typeof(p_ledger_rows) <> 'array' then
    raise exception 'Invoice lines and ledger rows must be arrays.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_line_items) = 0
     or jsonb_array_length(p_ledger_rows) = 0 then
    raise exception 'Invoice lines and ledger rows cannot be empty.'
      using errcode = '22023';
  end if;

  requested_rows := jsonb_array_length(p_ledger_rows);

  select count(*)
    into valid_rows
  from public.manual_invoice_authoritative_rows(
    p_client_id,
    p_period_start,
    p_period_end
  ) authoritative
  join (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ) requested on requested.commission_id = authoritative.commission_id::text;

  if valid_rows <> requested_rows then
    raise exception 'One or more ledger rows are duplicated, foreign, pre-start, post-end, out of period or not billable EUR Google spend.'
      using errcode = '22023';
  end if;

  select count(*)
    into expected_rows
  from public.manual_invoice_authoritative_rows(
    p_client_id,
    p_period_start,
    p_period_end
  );

  if expected_rows <> requested_rows then
    raise exception 'The request must claim every Google ledger row for the client week.'
      using errcode = '22023';
  end if;

  select
    count(*),
    count(distinct line->>'accountId'),
    coalesce(sum((line->>'amount')::numeric), 0)
    into expected_lines, distinct_line_accounts, lines_total
  from jsonb_array_elements(p_line_items) line;

  if distinct_line_accounts <> expected_lines then
    raise exception 'An invoice must contain exactly one line per store.'
      using errcode = '22023';
  end if;

  if lines_total <> p_amount then
    raise exception 'Invoice amount does not equal its line-item total.'
      using errcode = '22023';
  end if;

  -- Validate every cent-rounded explanatory value and its exact label against
  -- the micros-based authoritative rowset. The opening and closing evidence is
  -- required exactly when its boundary falls in this week, including when a
  -- downward restatement makes either deduction zero.
  with requested as (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ), per_store_exact as (
    select
      authoritative.account_id,
      authoritative.store_name,
      authoritative.billing_start_id,
      authoritative.billing_start_date,
      authoritative.billing_started_at,
      authoritative.billing_time_zone,
      max(authoritative.billing_start_baseline_micros) as start_baseline_micros,
      bool_or(authoritative.opening_baseline_applied) as opening_baseline_applied,
      authoritative.billing_end_id,
      authoritative.billing_end_date,
      authoritative.billing_ended_at,
      authoritative.billing_end_time_zone,
      authoritative.billing_end_counter_micros as end_counter_micros,
      bool_or(authoritative.ending_cap_applied) as ending_cap_applied,
      sum(authoritative.source_gross_amount) as source_gross_amount,
      sum(authoritative.baseline_deduction_amount) as baseline_deduction_amount,
      sum(authoritative.end_deduction_amount) as end_deduction_amount,
      sum(authoritative.billable_gross_amount) as billable_gross_amount
    from public.manual_invoice_authoritative_rows(
      p_client_id,
      p_period_start,
      p_period_end
    ) authoritative
    join requested on requested.commission_id = authoritative.commission_id::text
    group by
      authoritative.account_id,
      authoritative.store_name,
      authoritative.billing_start_id,
      authoritative.billing_start_date,
      authoritative.billing_started_at,
      authoritative.billing_time_zone,
      authoritative.billing_end_id,
      authoritative.billing_end_date,
      authoritative.billing_ended_at,
      authoritative.billing_end_time_zone,
      authoritative.billing_end_counter_micros
  ), per_store_values as (
    select
      exact.*,
      round(exact.source_gross_amount, 2) as source_gross_rounded,
      round(exact.baseline_deduction_amount, 2) as baseline_deduction_rounded,
      round(exact.end_deduction_amount, 2) as end_deduction_rounded,
      round(exact.billable_gross_amount, 2) as billable_gross_rounded,
      round(exact.start_baseline_micros / 1000000, 2) as start_baseline_rounded,
      round(exact.end_counter_micros / 1000000, 2) as end_counter_rounded,
      round(exact.billable_gross_amount * 0.10, 2) as fee_amount
    from per_store_exact exact
  ), per_store as (
    select
      value.*,
      case
        when value.opening_baseline_applied and value.ending_cap_applied then
          value.store_name
          || ' - Google Ads agency fee (10% of exact billable spend: EUR '
          || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
          || '; billing started '
          || to_char(
               value.billing_started_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || '; billing ended '
          || to_char(
               value.billing_ended_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || ' at Google day counter EUR '
          || to_char(value.end_counter_micros / 1000000, 'FM999999999999999990.000000')
          || '; billable period '
          || value.billing_start_date::text
          || ' to '
          || value.billing_end_date::text
          || ' in '
          || value.billing_end_time_zone
          || '; exact Google spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
          || ')'
        when value.opening_baseline_applied then
          value.store_name
          || ' - Google Ads agency fee (10% of exact billable spend: EUR '
          || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
          || '; billing started '
          || to_char(
               value.billing_started_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || '; first billable period '
          || value.billing_start_date::text
          || ' to '
          || p_period_end::text
          || ' in '
          || value.billing_time_zone
          || '; exact Google spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
          || ')'
        when value.ending_cap_applied then
          value.store_name
          || ' - Google Ads agency fee (10% of exact billable spend: EUR '
          || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
          || '; billing ended '
          || to_char(
               value.billing_ended_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || ' at Google day counter EUR '
          || to_char(value.end_counter_micros / 1000000, 'FM999999999999999990.000000')
          || '; final billable period '
          || p_period_start::text
          || ' to '
          || value.billing_end_date::text
          || ' in '
          || value.billing_end_time_zone
          || '; exact Google spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
          || ')'
        else
          value.store_name
          || ' - Google Ads agency fee (10% of exact billable spend: EUR '
          || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
          || ')'
      end as expected_label
    from per_store_values value
  )
  select count(*)
    into valid_lines
  from jsonb_array_elements(p_line_items) item
  cross join lateral jsonb_to_record(item) as line(
    "accountId" uuid,
    kind text,
    store text,
    label text,
    rate numeric,
    amount numeric,
    "baseAmount" numeric,
    "sourceGrossAmount" numeric,
    "baselineDeductionAmount" numeric,
    "billingStartBaselineAmount" numeric,
    "billingStartId" uuid,
    "billingStartDate" date,
    "billingStartedAt" timestamptz,
    "billingTimeZone" text,
    "billingEndId" uuid,
    "billingEndDate" date,
    "billingEndedAt" timestamptz,
    "billingEndTimeZone" text,
    "billingEndCounterAmount" numeric,
    "endingCapApplied" boolean,
    "endDeductionAmount" numeric
  )
  join per_store store on store.account_id = line."accountId"
  where line.kind = 'fee'
    and line.store = store.store_name
    and line.rate = 10
    and line.amount = store.fee_amount
    and line."baseAmount" = store.billable_gross_rounded
    and line."sourceGrossAmount" = store.source_gross_rounded
    and line."billingStartBaselineAmount" = store.start_baseline_rounded
    and line."billingStartId" = store.billing_start_id
    and line."billingStartDate" = store.billing_start_date
    and line."billingStartedAt" = store.billing_started_at
    and line."billingTimeZone" = store.billing_time_zone
    and (
      (
        store.opening_baseline_applied
        and item ? 'baselineDeductionAmount'
        and line."baselineDeductionAmount" = store.baseline_deduction_rounded
      )
      or
      (
        not store.opening_baseline_applied
        and not (item ? 'baselineDeductionAmount')
      )
    )
    and (
      (
        store.ending_cap_applied
        and item ? 'billingEndId'
        and item ? 'billingEndDate'
        and item ? 'billingEndedAt'
        and item ? 'billingEndTimeZone'
        and item ? 'billingEndCounterAmount'
        and item ? 'endingCapApplied'
        and item ? 'endDeductionAmount'
        and line."billingEndId" = store.billing_end_id
        and line."billingEndDate" = store.billing_end_date
        and line."billingEndedAt" = store.billing_ended_at
        and line."billingEndTimeZone" = store.billing_end_time_zone
        and line."billingEndCounterAmount" = store.end_counter_rounded
        and line."endingCapApplied" is true
        and line."endDeductionAmount" = store.end_deduction_rounded
      )
      or
      (
        not store.ending_cap_applied
        and not (item ? 'billingEndId')
        and not (item ? 'billingEndDate')
        and not (item ? 'billingEndedAt')
        and not (item ? 'billingEndTimeZone')
        and not (item ? 'billingEndCounterAmount')
        and not (item ? 'endingCapApplied')
        and not (item ? 'endDeductionAmount')
      )
    )
    and line.label = store.expected_label;

  if valid_lines <> expected_lines
     or expected_lines <> (
       with requested as (
         select distinct value->>'commission_id' as commission_id
         from jsonb_array_elements(p_ledger_rows)
       )
       select count(*)
       from (
         select authoritative.account_id
         from public.manual_invoice_authoritative_rows(
           p_client_id,
           p_period_start,
           p_period_end
         ) authoritative
         join requested on requested.commission_id = authoritative.commission_id::text
         group by authoritative.account_id
         having round(sum(authoritative.billable_gross_amount) * 0.10, 2) >= 0.01
       ) stores
     ) then
    raise exception 'Invoice lines do not match the fixed 10%% EUR fee and Google boundary evidence per store.'
      using errcode = '22023';
  end if;

  insert into public.invoices (
    client_id,
    period_start,
    period_end,
    amount,
    currency,
    status,
    due_date,
    line_items,
    issued_by,
    issue_attempted_at,
    calculation_version
  ) values (
    p_client_id,
    p_period_start,
    p_period_end,
    p_amount,
    'EUR',
    'draft',
    current_date + 7,
    p_line_items,
    p_issued_by,
    now(),
    p_calculation_version
  )
  returning * into created_invoice;

  insert into public.invoice_commission_rows (
    invoice_id,
    commission_id,
    gross_amount,
    billing_start_id,
    baseline_deduction_amount,
    billing_end_id,
    end_deduction_amount,
    billable_gross_amount,
    currency
  )
  select
    created_invoice.id,
    authoritative.commission_id,
    round(authoritative.source_gross_amount, 6),
    authoritative.billing_start_id,
    round(authoritative.baseline_deduction_amount, 6),
    authoritative.billing_end_id,
    case
      when authoritative.ending_cap_applied
        then round(authoritative.end_deduction_amount, 6)
    end,
    round(authoritative.billable_gross_amount, 6),
    'EUR'
  from public.manual_invoice_authoritative_rows(
    p_client_id,
    p_period_start,
    p_period_end
  ) authoritative
  join (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ) requested on requested.commission_id = authoritative.commission_id::text;

  if not found then
    raise exception 'No EUR Google ledger rows were claimed.'
      using errcode = '22023';
  end if;

  if (select count(*) from public.invoice_commission_rows where invoice_id = created_invoice.id)
     <> requested_rows then
    raise exception 'Every requested ledger row must be claimed exactly once.'
      using errcode = '22023';
  end if;

  return next created_invoice;
end
$$;

revoke all on function public.create_manual_invoice(uuid, date, date, numeric, jsonb, jsonb, uuid, text)
  from public, authenticated, anon;
grant execute on function public.create_manual_invoice(uuid, date, date, numeric, jsonb, jsonb, uuid, text)
  to service_role;

-- Stripe can retry and reorder webhooks. Persisting the event id before doing
-- any state transition gives the webhook an atomic de-duplication boundary and
-- leaves failed processing visible for reconciliation.
create table if not exists public.stripe_webhook_events (
  id text primary key,
  type text not null,
  stripe_created_at timestamptz not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
);

create index if not exists stripe_webhook_events_unprocessed_idx
  on public.stripe_webhook_events (received_at)
  where processed_at is null;

alter table public.stripe_webhook_events enable row level security;

drop policy if exists stripe_webhook_events_admin_read on public.stripe_webhook_events;
create policy stripe_webhook_events_admin_read on public.stripe_webhook_events
  for select using (public.is_admin());

-- There is deliberately no browser insert/update policy. Stripe's signed
-- webhook uses the service-role client and bypasses RLS.
