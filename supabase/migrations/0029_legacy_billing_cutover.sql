-- =============================================================================
-- 0029 - Explicit legacy-to-v3 billing cutover.
--
-- Production has pre-v3 draft calculations and account flags from the former
-- spend/revenue-share contract. None of those drafts was issued or linked to
-- Stripe, and the approved v3 contract is EUR agency fee only. Preserve every
-- original row as immutable evidence, cancel only the unissued local drafts,
-- and reset the live account cache to the 10% list contract before any Google
-- billing baseline can be captured.
--
-- This migration deliberately aborts on referrals, Stripe ambiguity, an
-- existing billing start, a non-EUR billable account or an unusable Google
-- identity. Those cases require a human decision; they are never guessed.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

create table public.manual_billing_cutovers (
  singleton boolean primary key default true
    constraint manual_billing_cutovers_singleton check (singleton),
  cutover_monday date not null
    constraint manual_billing_cutovers_monday
    check (extract(isodow from cutover_monday) = 1),
  archived_draft_count integer not null check (archived_draft_count >= 0),
  reset_account_count integer not null check (reset_account_count >= 0),
  acknowledged_legacy_google_row_count integer not null
    check (acknowledged_legacy_google_row_count >= 0),
  executed_at timestamptz not null default now(),
  executed_by text not null default current_user,
  disposition text not null
    constraint manual_billing_cutovers_disposition check (
      disposition =
        'Unissued legacy drafts preserved and cancelled; account billing contract reset to EUR agency fee only.'
    )
);

create table public.manual_billing_cutover_invoice_snapshots (
  invoice_id uuid primary key,
  snapshot jsonb not null
    constraint manual_billing_cutover_invoice_snapshot_object
    check (jsonb_typeof(snapshot) = 'object'),
  archived_at timestamptz not null default now()
);

create table public.manual_billing_cutover_account_snapshots (
  ad_account_id uuid primary key,
  snapshot jsonb not null
    constraint manual_billing_cutover_account_snapshot_object
    check (jsonb_typeof(snapshot) = 'object'),
  reset_at timestamptz not null default now()
);

create table public.manual_billing_cutover_commission_snapshots (
  commission_id uuid primary key,
  snapshot jsonb not null
    constraint manual_billing_cutover_commission_snapshot_object
    check (jsonb_typeof(snapshot) = 'object'),
  acknowledged_at timestamptz not null default now()
);

do $$
declare
  business_day date := (now() at time zone 'Europe/Lisbon')::date;
  cutover_monday date;
  archived_drafts integer := 0;
  reset_accounts integer := 0;
  acknowledged_rows integer := 0;
begin
  cutover_monday := business_day
    - (extract(isodow from business_day)::integer - 1);

  -- Drain every writer whose state is being classified. The deployment
  -- runbook keeps the old worker in maintenance for the complete multi-file
  -- cutover; these locks close the in-flight transaction window for this file.
  lock table
    public.portal_clients,
    public.profiles,
    public.ad_accounts,
    public.revenue_sources,
    public.commissions,
    public.invoices,
    public.ad_account_billing_starts,
    public.ad_account_billing_ends
  in share row exclusive mode;

  if exists (
    select 1
    from public.portal_clients client
    where client.referred_by is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: an existing referral attribution needs explicit admin review before v3 installation.';
  end if;

  if exists (select 1 from public.ad_account_billing_starts) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: a Google billing start already exists; do not move or recreate an immutable baseline.';
  end if;

  if exists (
    select 1
    from public.ad_accounts account
    where account.status in ('active', 'suspended')
      and not exists (
        select 1
        from public.profiles profile
        where profile.id = account.client_id
          and profile.role = 'admin'
      )
      and upper(account.currency) <> 'EUR'
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: every active or suspended client Google account must use EUR.';
  end if;

  if exists (
    select 1
    from public.ad_accounts account
    where account.status in ('active', 'suspended')
      and not exists (
        select 1
        from public.profiles profile
        where profile.id = account.client_id
          and profile.role = 'admin'
      )
      and (
        account.google_ads_customer_id is null
        or account.google_ads_customer_id !~ '^[0-9]{10}$'
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: every active or suspended client account needs one canonical 10-digit Google customer id before baseline capture.';
  end if;

  -- A local draft is safe to cancel only when there is no evidence that
  -- Stripe ever knew about it and no delivery/payment transition occurred.
  if exists (
    select 1
    from public.invoices invoice
    where invoice.status = 'draft'
      and (
        invoice.calculation_version <> 'legacy'
        or invoice.issued_at is not null
        or invoice.issued_by is not null
        or invoice.stripe_invoice_id is not null
        or invoice.stripe_hosted_url is not null
        or invoice.stripe_invoice_number is not null
        or invoice.stripe_invoice_pdf is not null
        or invoice.amount_remaining is not null
        or invoice.paid_at is not null
        or invoice.payment_failed_at is not null
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: a legacy draft has Stripe, issue or payment evidence and requires remote reconciliation.';
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.status in ('open', 'paid', 'void', 'uncollectible')
      and (
        invoice.issued_at is null
        or invoice.stripe_invoice_id is null
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 cutover: a non-draft legacy invoice is missing its issued or Stripe identity evidence.';
  end if;

  insert into public.manual_billing_cutover_invoice_snapshots (
    invoice_id,
    snapshot
  )
  select invoice.id, to_jsonb(invoice)
  from public.invoices invoice
  where invoice.status = 'draft'
    and invoice.issued_at is null;
  get diagnostics archived_drafts = row_count;

  insert into public.manual_billing_cutover_account_snapshots (
    ad_account_id,
    snapshot
  )
  select account.id, to_jsonb(account)
  from public.ad_accounts account
  where account.list_commission_rate is distinct from 10::numeric
     or account.commission_rate is distinct from 10::numeric
     or account.revenue_share_enabled;
  get diagnostics reset_accounts = row_count;

  insert into public.manual_billing_cutover_commission_snapshots (
    commission_id,
    snapshot
  )
  select commission.id, to_jsonb(commission)
  from public.commissions commission
  join public.revenue_sources source on source.id = commission.source_id
  where source.name = 'Google Ads Management'
    and commission.ad_account_id is not null
    and commission.rate is distinct from 10::numeric;
  get diagnostics acknowledged_rows = row_count;

  -- `referred_by` was proved empty above, so the legacy automatic-referral
  -- trigger cannot turn this reset back into a discount during the statement.
  update public.ad_accounts account
  set list_commission_rate = 10,
      commission_rate = 10,
      revenue_share_enabled = false
  where account.list_commission_rate is distinct from 10::numeric
     or account.commission_rate is distinct from 10::numeric
     or account.revenue_share_enabled;

  if exists (
    select 1
    from public.ad_accounts account
    where account.list_commission_rate is distinct from 10::numeric
       or account.commission_rate is distinct from 10::numeric
       or account.revenue_share_enabled
  ) then
    raise exception '0029 cutover: the 10%% fee-only account reset did not converge.';
  end if;

  update public.invoices invoice
  set status = 'void',
      issue_error =
        'Archived at the v3 cutover: this legacy draft was never issued to Stripe and is not collectible.',
      updated_at = now()
  where invoice.status = 'draft'
    and invoice.issued_at is null;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.status = 'draft'
      and invoice.issued_at is null
  ) then
    raise exception '0029 cutover: an unissued legacy draft remains unresolved.';
  end if;

  insert into public.manual_billing_cutovers (
    singleton,
    cutover_monday,
    archived_draft_count,
    reset_account_count,
    acknowledged_legacy_google_row_count,
    disposition
  ) values (
    true,
    cutover_monday,
    archived_drafts,
    reset_accounts,
    acknowledged_rows,
    'Unissued legacy drafts preserved and cancelled; account billing contract reset to EUR agency fee only.'
  );
end
$$;

alter table public.manual_billing_cutovers enable row level security;
alter table public.manual_billing_cutover_invoice_snapshots enable row level security;
alter table public.manual_billing_cutover_account_snapshots enable row level security;
alter table public.manual_billing_cutover_commission_snapshots enable row level security;

revoke insert, update, delete on
  public.manual_billing_cutovers,
  public.manual_billing_cutover_invoice_snapshots,
  public.manual_billing_cutover_account_snapshots,
  public.manual_billing_cutover_commission_snapshots
from public, authenticated, anon, service_role;

grant select on
  public.manual_billing_cutovers,
  public.manual_billing_cutover_invoice_snapshots,
  public.manual_billing_cutover_account_snapshots,
  public.manual_billing_cutover_commission_snapshots
to authenticated, service_role;

create policy manual_billing_cutovers_admin_read
  on public.manual_billing_cutovers for select using (public.is_admin());
create policy manual_billing_cutover_invoice_snapshots_admin_read
  on public.manual_billing_cutover_invoice_snapshots
  for select using (public.is_admin());
create policy manual_billing_cutover_account_snapshots_admin_read
  on public.manual_billing_cutover_account_snapshots
  for select using (public.is_admin());
create policy manual_billing_cutover_commission_snapshots_admin_read
  on public.manual_billing_cutover_commission_snapshots
  for select using (public.is_admin());

create or replace function public.guard_manual_billing_cutover_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'The manual billing cutover audit is immutable.'
    using errcode = '22023';
end
$$;

create trigger manual_billing_cutovers_guard_immutable
  before update or delete on public.manual_billing_cutovers
  for each row execute function public.guard_manual_billing_cutover_audit();
create trigger manual_billing_cutover_invoice_snapshots_guard_immutable
  before update or delete on public.manual_billing_cutover_invoice_snapshots
  for each row execute function public.guard_manual_billing_cutover_audit();
create trigger manual_billing_cutover_account_snapshots_guard_immutable
  before update or delete on public.manual_billing_cutover_account_snapshots
  for each row execute function public.guard_manual_billing_cutover_audit();
create trigger manual_billing_cutover_commission_snapshots_guard_immutable
  before update or delete on public.manual_billing_cutover_commission_snapshots
  for each row execute function public.guard_manual_billing_cutover_audit();

notify pgrst, 'reload schema';
