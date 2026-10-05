-- A human can explicitly accept the existing ledger when Google access is lost.
-- This is a separate, immutable approval, never a fabricated Google refresh.
-- It covers one account/week and the exact rows reviewed; ordinary automatic
-- issuance and every commercial, boundary, skip and duplication guard remain.
create table public.billing_cached_evidence_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  ad_account_id uuid not null references public.ad_accounts(id),
  billing_start_id uuid not null references public.ad_account_billing_starts(id),
  billing_end_id uuid references public.ad_account_billing_ends(id),
  period_start date not null,
  period_end date not null,
  ledger_snapshot jsonb not null check (jsonb_typeof(ledger_snapshot) = 'array'),
  last_ledger_update timestamptz not null,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  reason text not null check (length(trim(reason)) >= 15),
  check (extract(isodow from period_start) = 1 and period_end = period_start + 6)
);
create index billing_cached_evidence_period_idx
  on public.billing_cached_evidence_reviews(ad_account_id, period_start, period_end);
alter table public.billing_cached_evidence_reviews enable row level security;
revoke all on public.billing_cached_evidence_reviews from anon, authenticated, service_role;
grant select on public.billing_cached_evidence_reviews to authenticated, service_role;
create policy cached_evidence_admin_read on public.billing_cached_evidence_reviews
  for select to authenticated using (public.is_admin());

create table public.invoice_cached_evidence_reviews (
  invoice_id uuid not null references public.invoices(id),
  review_id uuid not null references public.billing_cached_evidence_reviews(id),
  primary key(invoice_id, review_id)
);
alter table public.invoice_cached_evidence_reviews enable row level security;
revoke all on public.invoice_cached_evidence_reviews from anon, authenticated, service_role;
grant select on public.invoice_cached_evidence_reviews to authenticated, service_role;
create policy invoice_cached_evidence_admin_read on public.invoice_cached_evidence_reviews
  for select to authenticated using (public.is_admin());

create function public.guard_cached_billing_review_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Cached billing evidence approvals are immutable.' using errcode = '42501';
end $$;
create trigger cached_billing_review_immutable before update or delete
  on public.billing_cached_evidence_reviews for each row
  execute function public.guard_cached_billing_review_immutable();
create trigger invoice_cached_review_immutable before update or delete
  on public.invoice_cached_evidence_reviews for each row
  execute function public.guard_cached_billing_review_immutable();

create function public.cached_billing_ledger_snapshot(
  p_account_id uuid, p_period_start date, p_period_end date
) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', commission.id::text,
    'occurred_on', commission.occurred_on::text,
    'gross_amount', to_char(commission.gross_amount, 'FM999999999999999990.000000'),
    'currency', upper(commission.currency),
    'status', commission.status
  ) order by commission.id), '[]'::jsonb)
  from public.commissions commission
  join public.revenue_sources source on source.id = commission.source_id
  join public.ad_account_billing_starts start on start.ad_account_id = commission.ad_account_id
  left join public.ad_account_billing_ends ending on ending.ad_account_id = commission.ad_account_id
    and ending.billing_start_id = start.id
  where commission.ad_account_id = p_account_id
    and source.name = 'Google Ads Management' and commission.status = 'confirmed'
    and commission.occurred_on between greatest(p_period_start, start.google_local_date)
      and least(p_period_end, coalesce(ending.google_local_date, p_period_end))
$$;
revoke all on function public.cached_billing_ledger_snapshot(uuid, date, date)
  from public, anon, authenticated, service_role;

create function public.approve_cached_billing_evidence(
  p_account_id uuid, p_period_start date, p_expected_snapshot jsonb,
  p_reviewed_by uuid, p_reason text
) returns setof public.billing_cached_evidence_reviews
language plpgsql security definer set search_path = public as $$
declare
  account public.ad_accounts;
  opening public.ad_account_billing_starts;
  ending public.ad_account_billing_ends;
  snapshot jsonb;
  result public.billing_cached_evidence_reviews;
  v_period_end date := p_period_start + 6;
  last_update timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service may record an explicit admin approval.' using errcode = '42501';
  end if;
  if p_reviewed_by is null or not exists (
    select 1 from public.profiles where id = p_reviewed_by and role = 'admin'
  ) then
    raise exception 'An admin reviewer is required.' using errcode = '42501';
  end if;
  if p_period_start is null or extract(isodow from p_period_start) <> 1
    or now() < ((p_period_start + 7) + time '14:05') at time zone 'UTC'
    or p_reason is null or length(trim(p_reason)) < 15 then
    raise exception 'A settled closed week and explicit review reason are required.' using errcode = '22023';
  end if;
  -- Same lock order as the invoice creator; an approval cannot race ledger edits.
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.revenue_sources in share row exclusive mode;
  lock table public.commissions in share row exclusive mode;
  select * into account from public.ad_accounts where id = p_account_id;
  select * into opening from public.ad_account_billing_starts where ad_account_id = p_account_id;
  select * into ending from public.ad_account_billing_ends where ad_account_id = p_account_id;
  if account.id is null or opening.id is null
    or account.status not in ('active', 'suspended')
    or account.google_ads_customer_id is distinct from opening.google_ads_customer_id
    or upper(account.currency) <> 'EUR' or opening.currency <> 'EUR'
    or opening.google_local_date > v_period_end
    or ending.google_local_date < p_period_start then
    raise exception 'The account has no matching billable EUR boundary for this week.' using errcode = '22023';
  end if;
  if exists(select 1 from public.billing_cycle_skips where client_id = account.client_id
    and period_start = p_period_start and billing_cycle_skips.period_end = v_period_end)
    or exists(select 1 from public.invoices where client_id = account.client_id
      and period_start = p_period_start and status <> 'void') then
    raise exception 'The client week is skipped or already invoiced.' using errcode = '23505';
  end if;
  snapshot := public.cached_billing_ledger_snapshot(p_account_id, p_period_start, v_period_end);
  if p_expected_snapshot is null or snapshot <> p_expected_snapshot
    or jsonb_array_length(snapshot) = 0
    or not exists(select 1 from jsonb_array_elements(snapshot) row where (row->>'gross_amount')::numeric > 0)
    or exists(select 1 from jsonb_array_elements(snapshot) row where row->>'currency' <> 'EUR'
      or (row->>'gross_amount')::numeric < 0) then
    raise exception 'The exact reviewed positive ledger snapshot is missing or changed.' using errcode = '40001';
  end if;
  select max(commission.updated_at) into last_update from public.commissions commission
    where commission.id in (select (row->>'id')::uuid from jsonb_array_elements(snapshot) row);
  select * into result from public.billing_cached_evidence_reviews review
    where review.ad_account_id = p_account_id and review.period_start = p_period_start
      and review.period_end = v_period_end and review.billing_start_id = opening.id
      and review.billing_end_id is not distinct from ending.id
      and review.reviewed_by = p_reviewed_by and review.ledger_snapshot = snapshot
    order by review.reviewed_at desc limit 1;
  if result.id is not null then return next result; return; end if;
  insert into public.billing_cached_evidence_reviews(client_id, ad_account_id,
    billing_start_id, billing_end_id, period_start, period_end, ledger_snapshot,
    last_ledger_update, reviewed_by, reason)
  values(account.client_id, p_account_id, opening.id, ending.id, p_period_start,
    v_period_end, snapshot, last_update, p_reviewed_by, trim(p_reason)) returning * into result;
  return next result;
end $$;
revoke all on function public.approve_cached_billing_evidence(uuid, date, jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.approve_cached_billing_evidence(uuid, date, jsonb, uuid, text) to service_role;

create function public.cached_billing_evidence_matches(
  p_account_id uuid, p_start_id uuid, p_end_id uuid,
  p_period_start date, p_period_end date, p_issued_by uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select p_issued_by is not null and exists(
    select 1 from public.billing_cached_evidence_reviews review
    join public.ad_accounts account on account.id = review.ad_account_id
    join public.ad_account_billing_starts opening on opening.ad_account_id = account.id
    left join public.ad_account_billing_ends ending on ending.ad_account_id = account.id
    join public.profiles reviewer on reviewer.id = review.reviewed_by and reviewer.role = 'admin'
    where review.ad_account_id = p_account_id and review.client_id = account.client_id
      and review.billing_start_id = p_start_id and review.billing_end_id is not distinct from p_end_id
      and opening.id = p_start_id and ending.id is not distinct from p_end_id
      and account.google_ads_customer_id = opening.google_ads_customer_id
      and upper(account.currency) = 'EUR' and opening.currency = 'EUR'
      and review.period_start = p_period_start and review.period_end = p_period_end
      and review.reviewed_by = p_issued_by
      and review.ledger_snapshot = public.cached_billing_ledger_snapshot(p_account_id, p_period_start, p_period_end)
  )
$$;
revoke all on function public.cached_billing_evidence_matches(uuid, uuid, uuid, date, date, uuid)
  from public, anon, authenticated, service_role;

-- Change only the evidence alternative in the latest validated creator (0079).
-- Fail closed on unexpected function lineage instead of replacing other guards.
do $migration$
declare
  definition text := pg_get_functiondef('public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure);
  old_open text := E'        and exists (\n          select 1\n          from public.google_ledger_sync_windows sync';
  new_open text := E'        and (public.cached_billing_evidence_matches(account.id, billing_start.id, billing_end.id, p_period_start, p_period_end, p_issued_by) or exists (\n          select 1\n          from public.google_ledger_sync_windows sync';
  old_close text := E'        )\n    )\n    into account_count, ready_account_count';
  new_close text := E'        ))\n    )\n    into account_count, ready_account_count';
  old_return text := '  return next created_invoice;';
  new_return text := $replacement$
  insert into public.invoice_cached_evidence_reviews(invoice_id, review_id)
  select created_invoice.id, review.id from public.billing_cached_evidence_reviews review
  where review.client_id = p_client_id and review.period_start = p_period_start
    and review.period_end = p_period_end and review.reviewed_by = p_issued_by
    and review.ledger_snapshot = public.cached_billing_ledger_snapshot(review.ad_account_id, p_period_start, p_period_end)
    and public.cached_billing_evidence_matches(review.ad_account_id, review.billing_start_id,
      review.billing_end_id, p_period_start, p_period_end, p_issued_by);
  return next created_invoice;$replacement$;
begin
  if (length(definition) - length(replace(definition, old_open, ''))) <> length(old_open)
    or (length(definition) - length(replace(definition, old_close, ''))) <> length(old_close)
    or (length(definition) - length(replace(definition, old_return, ''))) <> length(old_return) then
    raise exception 'Unexpected invoice creator lineage; cached-evidence migration refused.';
  end if;
  execute replace(replace(replace(definition, old_open, new_open), old_close, new_close), old_return, new_return);
end $migration$;
