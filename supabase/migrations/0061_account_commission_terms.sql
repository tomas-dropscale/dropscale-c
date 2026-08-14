-- 0061 — Monday-effective per-account commission terms and v4 billing.
-- Mechanical base: the live 0037 invoice RPC is replaced below without editing history.
--
-- A manual list-rate edit is a dated commercial decision, not a mutable
-- property that may be applied to an arbitrary historical week. Production
-- reached this migration with every account on the 10% default; that clean
-- boundary lets a missing term mean exactly 10% before the first decision.

do $$
begin
  lock table public.ad_accounts in share row exclusive mode;
  if exists (
    select 1
    from public.ad_accounts account
    where account.list_commission_rate is distinct from 10::numeric
  ) then
    raise exception '0061 preflight: custom list rates require an explicit reviewed historical rollover.'
      using errcode = 'P0001';
  end if;
end
$$;

create table public.ad_account_commission_terms (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null
    references public.ad_accounts (id) on delete restrict,
  effective_from date not null,
  revision integer not null check (revision >= 1),
  supersedes_id uuid unique
    references public.ad_account_commission_terms (id) on delete restrict,
  decision_id uuid not null unique,
  list_rate numeric(5,2) not null
    check (list_rate >= 0 and list_rate <= 100),
  reviewed_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  sealed_at timestamptz not null default now(),
  constraint ad_account_commission_terms_monday
    check (extract(isodow from effective_from) = 1),
  constraint ad_account_commission_terms_account_week_revision
    unique (ad_account_id, effective_from, revision)
);

create index ad_account_commission_terms_resolve_idx
  on public.ad_account_commission_terms
    (ad_account_id, effective_from desc, revision desc);

comment on table public.ad_account_commission_terms is
  'Append-only Monday-effective per-store list-rate decisions. Absence means the audited 10% default.';

alter table public.ad_account_commission_terms enable row level security;
revoke all on table public.ad_account_commission_terms
  from public, anon, authenticated, service_role;
grant select on public.ad_account_commission_terms to authenticated, service_role;

create policy ad_account_commission_terms_admin_service_read
  on public.ad_account_commission_terms for select
  using (public.is_admin() or auth.role() = 'service_role');

create or replace function public.guard_ad_account_commission_term_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'An account commission term is append-only.'
    using errcode = '22023';
end
$$;

create trigger ad_account_commission_terms_guard_immutable
  before update or delete on public.ad_account_commission_terms
  for each row execute function public.guard_ad_account_commission_term_immutable();

create or replace function public.resolve_ad_account_commission_term(
  p_ad_account_id uuid,
  p_period_start date
)
returns table (
  term_id uuid,
  effective_from date,
  revision integer,
  list_rate numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_ad_account_id is null
     or p_period_start is null
     or extract(isodow from p_period_start) <> 1 then
    raise exception 'An account commission term resolves only for an account and Monday billing period.'
      using errcode = '22023';
  end if;

  return query
  select
    term.id,
    term.effective_from,
    term.revision,
    term.list_rate
  from public.ad_account_commission_terms term
  where term.ad_account_id = p_ad_account_id
    and term.effective_from <= p_period_start
    and term.sealed_at is not null
  order by term.effective_from desc, term.revision desc
  limit 1;

  if not found then
    term_id := null;
    effective_from := null;
    revision := 0;
    list_rate := 10;
    return next;
  end if;
end
$$;

revoke all on function public.resolve_ad_account_commission_term(uuid, date)
  from public, anon, authenticated;
grant execute on function public.resolve_ad_account_commission_term(uuid, date)
  to service_role;

-- Every list-rate mutation now travels through the append-only scheduler.
-- Referral/cache refreshes use a transaction-local flag and never create a
-- commercial decision themselves.
create or replace function public.guard_ad_account_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.list_commission_rate is distinct from 10::numeric then
      raise exception 'A custom list rate must be scheduled through its reviewed RPC.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.list_commission_rate is distinct from old.list_commission_rate
     then
    if coalesce(
         current_setting('dropscale.account_commission_term_rpc', true),
         ''
       ) <> 'on'
       or not exists (
         select 1
         from public.resolve_ad_account_commission_term(
           new.id,
           public.manual_referral_current_monday(
             (now() at time zone 'Europe/Lisbon')::date
           )
         ) term
         where term.list_rate = new.list_commission_rate
       ) then
      raise exception 'A custom list rate must be scheduled through its reviewed RPC.'
        using errcode = '42501';
    end if;
  end if;

  if new.revenue_share_enabled is distinct from old.revenue_share_enabled
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only the team can change an account''s billing settings.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists ad_accounts_guard_commission on public.ad_accounts;
create trigger ad_accounts_guard_commission
  before insert or update on public.ad_accounts
  for each row execute function public.guard_ad_account_commission();

create or replace function public.schedule_ad_account_commission_rate(
  p_account_id uuid,
  p_list_rate numeric,
  p_expected_term_id uuid,
  p_decision_id uuid
)
returns setof public.ad_account_commission_terms
language plpgsql
security definer
set search_path = public
as $$
declare
  decision_day date := (now() at time zone 'Europe/Lisbon')::date;
  target_monday date;
  target_account public.ad_accounts%rowtype;
  current_term public.ad_account_commission_terms%rowtype;
  replay_term public.ad_account_commission_terms%rowtype;
  created_term public.ad_account_commission_terms%rowtype;
  next_revision integer;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated admin can schedule an account commission rate.'
      using errcode = '42501';
  end if;
  if p_account_id is null
     or p_decision_id is null
     or p_list_rate is null
     or p_list_rate < 0
     or p_list_rate > 100
     or p_list_rate <> round(p_list_rate, 2) then
    raise exception 'A commission rate must be between 0 and 100 with at most two decimal places.'
      using errcode = '22023';
  end if;

  -- Invoice creation takes these two commercial locks in this order. Matching
  -- it avoids a Monday scheduler/invoice deadlock and also serializes exact
  -- decision-id replays before their optimistic head check.
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_commission_terms in share row exclusive mode;

  select * into strict target_account
  from public.ad_accounts account
  where account.id = p_account_id
  for update;

  select * into replay_term
  from public.ad_account_commission_terms term
  where term.decision_id = p_decision_id;
  if found then
    if replay_term.ad_account_id is distinct from p_account_id
       or replay_term.list_rate is distinct from p_list_rate
       or replay_term.supersedes_id is distinct from p_expected_term_id
       or replay_term.reviewed_by is distinct from auth.uid() then
      raise exception 'The commission decision id was already used for another decision.'
        using errcode = '22023';
    end if;
    return next replay_term;
    return;
  end if;

  select * into current_term
  from public.ad_account_commission_terms term
  where term.ad_account_id = p_account_id
    and term.sealed_at is not null
  order by term.effective_from desc, term.revision desc
  limit 1;

  if current_term.id is distinct from p_expected_term_id then
    raise exception 'The account commission term changed. Refresh and review it again.'
      using errcode = '40001';
  end if;

  target_monday := public.manual_referral_effective_monday(decision_day);
  select coalesce(max(term.revision), 0) + 1 into next_revision
  from public.ad_account_commission_terms term
  where term.ad_account_id = p_account_id
    and term.effective_from = target_monday;

  insert into public.ad_account_commission_terms (
    ad_account_id,
    effective_from,
    revision,
    supersedes_id,
    decision_id,
    list_rate,
    reviewed_by
  ) values (
    p_account_id,
    target_monday,
    next_revision,
    current_term.id,
    p_decision_id,
    p_list_rate,
    auth.uid()
  ) returning * into created_term;

  -- A Monday decision owns that whole weekly commercial period. Decisions on
  -- every other day remain scheduled until the next Monday cache sweep.
  if target_monday <= public.manual_referral_current_monday(decision_day) then
    perform set_config('dropscale.account_commission_term_rpc', 'on', true);
    update public.ad_accounts account
    set list_commission_rate = p_list_rate
    where account.id = p_account_id;
  end if;

  return next created_term;
end
$$;

revoke all on function public.schedule_ad_account_commission_rate(
  uuid, numeric, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.schedule_ad_account_commission_rate(
  uuid, numeric, uuid, uuid
) to authenticated;

create or replace function public.refresh_referrer_rates(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_monday date := public.manual_referral_current_monday(
    (now() at time zone 'Europe/Lisbon')::date
  );
begin
  if p_client_id is null then return; end if;
  perform set_config('dropscale.account_commission_term_rpc', 'on', true);
  with desired as (
    select account.id, term.list_rate
    from public.ad_accounts account
    cross join lateral public.resolve_ad_account_commission_term(
      account.id,
      current_monday
    ) term
    where account.client_id = p_client_id
  )
  update public.ad_accounts account
  set list_commission_rate = desired.list_rate
  from desired
  where account.client_id = p_client_id
    and account.id = desired.id
    and (
      account.list_commission_rate is distinct from desired.list_rate
      or account.commission_rate is distinct from
        public.effective_commission_rate(account.client_id, desired.list_rate)
    );
end
$$;

create or replace function public.refresh_all_referral_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_monday date := public.manual_referral_current_monday(
    (now() at time zone 'Europe/Lisbon')::date
  );
  changed integer;
begin
  perform set_config('dropscale.account_commission_term_rpc', 'on', true);
  with desired as (
    select account.id, term.list_rate
    from public.ad_accounts account
    cross join lateral public.resolve_ad_account_commission_term(
      account.id,
      current_monday
    ) term
  ), updated as (
    update public.ad_accounts account
    set list_commission_rate = desired.list_rate
    from desired
    where account.id = desired.id
      and (
        account.list_commission_rate is distinct from desired.list_rate
        or account.commission_rate is distinct from
          public.effective_commission_rate(account.client_id, desired.list_rate)
      )
    returning 1
  )
  select count(*)::int into changed from updated;
  return changed;
end
$$;

revoke all on function public.refresh_referrer_rates(uuid)
  from public, anon, authenticated;
revoke all on function public.refresh_all_referral_rates()
  from public, anon, authenticated;
grant execute on function public.refresh_all_referral_rates() to service_role;

-- 0037 — collection revenue share joins the weekly settlement.
--
-- Accounts that opted into product-research tracking (ad_accounts.
-- revenue_share_rate > 0) settle the closed week's computed share — the
-- daily_metrics rollup written by the campaign-name deal engine — as one
-- `rev_share` line beside the store's `fee` line, inside the same immutable
-- billing boundaries. The fee validation is untouched and runs over the fee
-- subset; the invoice total must equal every line together. The legacy
-- revenue_share_enabled flag keeps its meaning (it still hard-blocks
-- automatic billing) and is not consulted here.
--
-- Replaces create_manual_referral_invoice from 0030 (definition taken from
-- the live, audited function). Reentrant: CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION public.create_manual_referral_invoice(p_client_id uuid, p_period_start date, p_period_end date, p_amount numeric, p_line_items jsonb, p_ledger_rows jsonb, p_billing_recipient jsonb, p_referral_term_id uuid, p_issued_by uuid, p_calculation_version text)
 RETURNS SETOF invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  created_invoice public.invoices;
  commercial_term record;
  requested_rows integer;
  valid_rows integer;
  expected_rows integer;
  expected_lines integer;
  valid_lines integer;
  distinct_line_accounts integer;
  client_count integer;
  missing_start_count integer;
  incompatible_terms_count integer;
  account_count integer;
  ready_account_count integer;
  referral_events_count integer;
  uses_referral_pricing boolean;
  is_v4 boolean;
  lines_total numeric;
  fee_lines jsonb;
  revshare_requested integer;
  revshare_expected integer;
  revshare_valid integer;
  billable_total numeric;
  expected_billing_recipient jsonb;
  business_day date := (now() at time zone 'Europe/Lisbon')::date;
  v3_cutover_monday date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can create a manual referral invoice.'
      using errcode = '42501';
  end if;

  if p_issued_by is not null and not exists (
    select 1 from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required to create a manual referral invoice.'
      using errcode = '42501';
  end if;

  -- Serialize source identity, recipient identity, Google evidence and
  -- commercial-term resolution. The supplied JSON is compared only after
  -- these locks, so a concurrent profile edit cannot slip between review and
  -- persistence.
  lock table public.portal_clients in share row exclusive mode;
  lock table public.billing_profiles in share row exclusive mode;
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.reviewed_full_day_billing_boundaries in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.commissions in share row exclusive mode;
  lock table public.google_ledger_sync_windows in share row exclusive mode;
  lock table public.referral_discount_terms in share row exclusive mode;
  lock table public.referral_discount_term_items in share row exclusive mode;
  lock table public.ad_account_commission_terms in share row exclusive mode;

  select config.v3_cutover_monday into v3_cutover_monday
  from public.manual_referral_billing_config config
  where config.singleton;

  if v3_cutover_monday is null then
    raise exception 'The v3 referral billing cutover is not configured.'
      using errcode = '22023';
  end if;

  if p_period_start < v3_cutover_monday then
    raise exception 'A pre-cutover week cannot be priced by the v3 10%% default.'
      using errcode = '22023';
  end if;

  if p_period_end <> p_period_start + 6
     or extract(isodow from p_period_start) <> 1
     or p_period_end >= business_day
     or now() < (
       ((p_period_end + 1)::timestamp at time zone 'UTC')
         + interval '14 hours 5 minutes'
     ) then
    raise exception 'Only a fully closed and Google-settled Monday-to-Sunday week can be settled.'
      using errcode = '22023';
  end if;

  if p_amount is null
     or p_amount <> round(p_amount, 2)
     or p_amount < 0
     or p_calculation_version is null
     or p_calculation_version not in (
       'agency-fee-eur-v3-manual-referrals-google-boundaries',
       'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries'
     ) then
    raise exception 'Invalid reviewed agency-fee calculation.'
      using errcode = '22023';
  end if;
  is_v4 := p_calculation_version =
    'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries';

  if not public.is_valid_invoice_billing_recipient(p_billing_recipient) then
    raise exception 'The reviewed invoice recipient has an invalid or incomplete shape.'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'email', client.email,
    'fallbackName', client.full_name,
    'billingName', billing_profile.billing_name,
    'taxId', billing_profile.tax_id,
    'addressLine1', billing_profile.address_line1,
    'addressLine2', billing_profile.address_line2,
    'addressCity', billing_profile.address_city,
    'addressPostalCode', billing_profile.address_postal_code,
    'addressState', billing_profile.address_state,
    'addressCountry', billing_profile.address_country
  ) into expected_billing_recipient
  from public.portal_clients client
  left join public.billing_profiles billing_profile
    on billing_profile.client_id = client.id
  where client.id = p_client_id;

  if expected_billing_recipient is null
     or p_billing_recipient is distinct from expected_billing_recipient then
    raise exception 'The reviewed invoice recipient changed before the invoice was created.'
      using errcode = '40001';
  end if;

  select * into commercial_term
  from public.resolve_manual_referral_term(p_client_id, p_period_start);

  select count(*) into client_count
  from public.portal_clients client
  where client.id = p_client_id
    and client.approval_status in ('approved', 'rejected')
    and not exists (
      select 1 from public.profiles profile
      where profile.id = client.id and profile.role = 'admin'
    );

  if client_count <> 1 then
    raise exception 'Only a billable, non-admin portal client can be settled.'
      using errcode = '22023';
  end if;

  select count(*) into missing_start_count
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

  -- Preserve the byte-shape and commercial semantics of a V3 request during a
  -- rolling deploy. V4 alone resolves per-store account terms; it pins the
  -- client referral term only when a positive-spend store uses that path.
  if is_v4 then
    select exists (
      select 1
      from public.manual_invoice_authoritative_rows(
        p_client_id, p_period_start, p_period_end
      ) authoritative
      cross join lateral public.resolve_ad_account_commission_term(
        authoritative.account_id,
        p_period_start
      ) account_term
      where authoritative.billable_gross_amount > 0
        and account_term.list_rate = 10
    ) into uses_referral_pricing;
  else
    uses_referral_pricing := true;
  end if;

  if (case when uses_referral_pricing then commercial_term.term_id else null end)
       is distinct from p_referral_term_id then
    raise exception 'The applicable referral or account commission term changed before issue.'
      using errcode = '40001';
  end if;

  -- The older boolean revenue-share contract remains a different commercial
  -- model. Collection revenue_share_rate lines stay validated below.
  select count(*) into incompatible_terms_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.google_local_date <= p_period_end
    and (billing_end.id is null or billing_end.google_local_date >= p_period_start)
    and (
      account.revenue_share_enabled
      or (not is_v4 and account.list_commission_rate <> 10)
    );

  if incompatible_terms_count <> 0 then
    raise exception 'Legacy revenue-share terms are incompatible with reviewed agency billing.'
      using errcode = '22023';
  end if;

  -- Require the same post-close, identity-bound, exact Google snapshot as v2.
  select
    count(*),
    count(*) filter (
      where upper(account.currency) = 'EUR'
        and billing_start.currency = 'EUR'
        and billing_start.google_ads_customer_id = account.google_ads_customer_id
        and (
          (
            billing_start.start_basis = 'observed_google_counter'
            and billing_start.reviewed_full_day_boundary_id is null
            and billing_start.baseline_cost_micros is not null
            and billing_start.captured_at is not null
          )
          or exists (
            select 1
            from public.reviewed_full_day_billing_boundaries boundary
            where billing_start.start_basis = 'reviewed_full_day'
              and boundary.id = billing_start.reviewed_full_day_boundary_id
              and boundary.ad_account_id = billing_start.ad_account_id
              and boundary.google_ads_customer_id = billing_start.google_ads_customer_id
              and boundary.google_local_date = billing_start.google_local_date
              and boundary.google_time_zone = billing_start.google_time_zone
              and boundary.currency = billing_start.currency
          )
        )
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
              and least(p_period_end, coalesce(billing_end.google_local_date, p_period_end))
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
              or (billing_end.google_local_date > p_period_end and sync.billing_end_id is null)
            )
            and sync.period_start = p_period_start
            and sync.period_end = p_period_end
            and sync.status = 'complete'
            and (sync.synced_at at time zone billing_start.google_time_zone)::date > p_period_end
            and sync.ledger_snapshot = (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id', commission.id::text,
                    'occurred_on', commission.occurred_on::text,
                    'gross_amount', to_char(
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
              join public.revenue_sources source on source.id = commission.source_id
              where commission.ad_account_id = account.id
                and source.name = 'Google Ads Management'
                and commission.status = 'confirmed'
                and commission.occurred_on between
                  greatest(p_period_start, billing_start.google_local_date)
                  and least(p_period_end, coalesce(billing_end.google_local_date, p_period_end))
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
    and (billing_end.id is null or billing_end.google_local_date >= p_period_start);

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
     or jsonb_typeof(p_ledger_rows) <> 'array'
     or jsonb_array_length(p_line_items) = 0
     or jsonb_array_length(p_ledger_rows) = 0 then
    raise exception 'Settlement lines and ledger rows must be non-empty arrays.'
      using errcode = '22023';
  end if;

  requested_rows := jsonb_array_length(p_ledger_rows);

  select count(*) into valid_rows
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
  ) authoritative
  join (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ) requested on requested.commission_id = authoritative.commission_id::text;

  if valid_rows <> requested_rows then
    raise exception 'One or more ledger rows are duplicated, foreign, pre-start, post-end, out of period or not billable EUR Google spend.'
      using errcode = '22023';
  end if;

  select count(*), coalesce(sum(billable_gross_amount), 0)
    into expected_rows, billable_total
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
  );

  if expected_rows <> requested_rows then
    raise exception 'The request must claim every Google ledger row for the client week.'
      using errcode = '22023';
  end if;
  if billable_total <= 0 then
    raise exception 'A week without positive billable Google spend has nothing to settle.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_line_items) line
    where coalesce(line->>'kind', '') not in ('fee', 'rev_share')
  ) then
    raise exception 'Settlement lines carry an unknown kind.'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(line), '[]'::jsonb)
    into fee_lines
  from jsonb_array_elements(p_line_items) line
  where line->>'kind' = 'fee';

  if jsonb_array_length(fee_lines) = 0 then
    raise exception 'A settlement requires at least one agency fee line.'
      using errcode = '22023';
  end if;

  -- Collection revenue share: accounts that opted into tracking
  -- (revenue_share_rate > 0) settle the week's computed share from the
  -- daily_metrics rollup, clipped to the same immutable billing boundaries
  -- as the fee. Every expected line must be claimed exactly, and no
  -- revenue-share line may exist without its rollup evidence.
  with expected as (
    select
      account.id as account_id,
      account.store_name,
      account.revenue_share_rate as rate,
      round(sum(metric.revenue_share_base), 2) as base_rounded,
      round(sum(metric.revenue_share_amount), 2) as amount_rounded
    from public.ad_accounts account
    join public.ad_account_billing_starts billing_start
      on billing_start.ad_account_id = account.id
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = account.id
    join public.daily_metrics metric
      on metric.ad_account_id = account.id
     and metric.day >= greatest(p_period_start, billing_start.google_local_date)
     and metric.day <= least(
           p_period_end,
           coalesce(billing_end.google_local_date, p_period_end)
         )
     and metric.revenue_share_amount > 0
    where account.client_id = p_client_id
      and account.status in ('active', 'suspended')
      and account.revenue_share_rate > 0
    group by account.id, account.store_name, account.revenue_share_rate
    having round(sum(metric.revenue_share_amount), 2) > 0
  ), requested_share as (
    select
      (line->>'accountId')::uuid as account_id,
      line->>'store' as store,
      (line->>'rate')::numeric as rate,
      (line->>'baseAmount')::numeric as base_amount,
      (line->>'amount')::numeric as amount,
      line->>'label' as label
    from jsonb_array_elements(p_line_items) line
    where line->>'kind' = 'rev_share'
  )
  select
    (select count(*) from requested_share),
    (select count(*) from expected),
    (select count(*)
     from requested_share requested
     join expected on expected.account_id = requested.account_id
     where requested.store = expected.store_name
       and requested.rate = expected.rate
       and requested.base_amount = expected.base_rounded
       and requested.amount = expected.amount_rounded
       and requested.label = expected.store_name
         || ' - Collection revenue share ('
         || public.manual_referral_rate_text(expected.rate)
         || '% deals on attributed collection revenue: EUR '
         || to_char(expected.base_rounded, 'FM999999999999999990.00')
         || '; computed share EUR '
         || to_char(expected.amount_rounded, 'FM999999999999999990.00')
         || ')')
    into revshare_requested, revshare_expected, revshare_valid;

  if revshare_requested <> revshare_expected
     or revshare_valid <> revshare_expected then
    raise exception 'Revenue share lines do not match the tracked collection evidence.'
      using errcode = '22023';
  end if;


  select
    count(*),
    count(distinct line->>'accountId')
    into expected_lines, distinct_line_accounts
  from jsonb_array_elements(fee_lines) line;

  select coalesce(sum((line->>'amount')::numeric), 0)
    into lines_total
  from jsonb_array_elements(p_line_items) line;

  if distinct_line_accounts <> expected_lines then
    raise exception 'A settlement must contain exactly one line per included store.'
      using errcode = '22023';
  end if;
  if lines_total <> p_amount then
    raise exception 'Settlement amount does not equal its line-item total.'
      using errcode = '22023';
  end if;


  -- Reconstruct every visible field and the exact Stripe/local description.
  -- Observed starts retain their counter receipt. Reviewed starts instead bind
  -- the immutable full-day proof and forbid capture/counter-looking fields.
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
      billing_start.start_basis as billing_start_basis,
      billing_start.reviewed_full_day_boundary_id,
      reviewed_boundary.policy_version as billing_policy_version,
      reviewed_boundary.entry_day as commercial_entry_day,
      reviewed_boundary.entry_time_zone as commercial_entry_time_zone,
      reviewed_boundary.entry_day_treatment,
      (
        billing_start.start_basis = 'reviewed_full_day'
        and billing_start.google_local_date
              between p_period_start and p_period_end
      ) as reviewed_full_day_applied,
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
      p_client_id, p_period_start, p_period_end
    ) authoritative
    join requested on requested.commission_id = authoritative.commission_id::text
    join public.ad_account_billing_starts billing_start
      on billing_start.id = authoritative.billing_start_id
     and billing_start.ad_account_id = authoritative.account_id
    left join public.reviewed_full_day_billing_boundaries reviewed_boundary
      on reviewed_boundary.id = billing_start.reviewed_full_day_boundary_id
     and reviewed_boundary.ad_account_id = billing_start.ad_account_id
     and reviewed_boundary.google_local_date = billing_start.google_local_date
     and reviewed_boundary.google_time_zone = billing_start.google_time_zone
     and reviewed_boundary.currency = billing_start.currency
    group by
      authoritative.account_id,
      authoritative.store_name,
      authoritative.billing_start_id,
      authoritative.billing_start_date,
      authoritative.billing_started_at,
      authoritative.billing_time_zone,
      billing_start.start_basis,
      billing_start.reviewed_full_day_boundary_id,
      reviewed_boundary.policy_version,
      reviewed_boundary.entry_day,
      reviewed_boundary.entry_time_zone,
      reviewed_boundary.entry_day_treatment,
      billing_start.google_local_date,
      authoritative.billing_end_id,
      authoritative.billing_end_date,
      authoritative.billing_ended_at,
      authoritative.billing_end_time_zone,
      authoritative.billing_end_counter_micros
    -- Every positive-spend store remains in the immutable local invoice proof.
    -- Stripe receives only payable lines, but a store whose fee rounds to zero
    -- must not disappear from the admin/client audit trail.
    having sum(authoritative.billable_gross_amount) > 0
  ), per_store_values as (
    select
      exact.*,
      case when is_v4 then account_term.term_id end as commission_term_id,
      case when is_v4 then account_term.list_rate
        else commercial_term.list_rate end as list_rate,
      case when is_v4 then
        case when account_term.list_rate = 10 then 'referral' else 'manual' end
      end as pricing_mode,
      case when not is_v4 or account_term.list_rate = 10
        then commercial_term.referral_count else 0 end as referral_count,
      case when not is_v4 or account_term.list_rate = 10
        then commercial_term.referral_discount_rate else 0 end
        as referral_discount_rate,
      case when not is_v4 or account_term.list_rate = 10
        then commercial_term.fee_rate else account_term.list_rate end as fee_rate,
      round(exact.source_gross_amount, 2) as source_gross_rounded,
      round(exact.baseline_deduction_amount, 2) as baseline_deduction_rounded,
      round(exact.end_deduction_amount, 2) as end_deduction_rounded,
      round(exact.billable_gross_amount, 2) as billable_gross_rounded,
      case
        when exact.billing_start_basis = 'observed_google_counter'
          then round(exact.start_baseline_micros / 1000000, 2)
      end as start_baseline_rounded,
      round(exact.end_counter_micros / 1000000, 2) as end_counter_rounded,
      round(
        exact.billable_gross_amount
          * (case when not is_v4 or account_term.list_rate = 10
              then commercial_term.fee_rate else account_term.list_rate end)
          / 100,
        2
      )
        as fee_amount
    from per_store_exact exact
    cross join lateral public.resolve_ad_account_commission_term(
      exact.account_id,
      p_period_start
    ) account_term
  ), per_store as (
    select
      value.*,
      value.store_name
      || ' - Google Ads agency fee ('
      || public.manual_referral_rate_text(value.fee_rate)
      || '% of captured Google-reported billable spend: EUR '
      || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
      || case when is_v4 and value.pricing_mode = 'manual' then
           '; manual account list rate: '
           || public.manual_referral_rate_text(value.list_rate)
           || '%'
         else
           '; manual referral term: approved referral count '
           || value.referral_count::text
           || '; 10% - '
           || public.manual_referral_rate_text(value.referral_discount_rate)
           || ' percentage points = '
           || public.manual_referral_rate_text(value.fee_rate)
           || '%'
         end
      || case
        when value.reviewed_full_day_applied and value.ending_cap_applied then
          '; billing began under reviewed full-day policy '
          || value.billing_policy_version
          || '; full '
          || value.billing_time_zone
          || ' Google reporting day '
          || value.billing_start_date::text
          || ' included; commercial entry '
          || value.commercial_entry_day::text
          || ' in '
          || value.commercial_entry_time_zone
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
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
        when value.reviewed_full_day_applied then
          '; billing began under reviewed full-day policy '
          || value.billing_policy_version
          || '; full '
          || value.billing_time_zone
          || ' Google reporting day '
          || value.billing_start_date::text
          || ' included; commercial entry '
          || value.commercial_entry_day::text
          || ' in '
          || value.commercial_entry_time_zone
          || '; first billable period '
          || value.billing_start_date::text
          || ' to '
          || p_period_end::text
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
        when value.opening_baseline_applied and value.ending_cap_applied then
          '; billing started '
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
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
        when value.opening_baseline_applied then
          '; billing started '
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
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
        when value.ending_cap_applied then
          '; billing ended '
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
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
        else ''
      end
      || ')' as expected_label
    from per_store_values value
  )
  select count(*) into valid_lines
  from jsonb_array_elements(fee_lines) item
  cross join lateral jsonb_to_record(item) as line(
    "accountId" uuid,
    kind text,
    store text,
    label text,
    rate numeric,
    amount numeric,
    "pricingMode" text,
    "commissionTermId" uuid,
    "listRate" numeric,
    "referralDiscountRate" numeric,
    "referralCount" integer,
    "baseAmount" numeric,
    "sourceGrossAmount" numeric,
    "baselineDeductionAmount" numeric,
    "billingStartBasis" text,
    "billingStartBaselineAmount" numeric,
    "billingStartId" uuid,
    "billingStartDate" date,
    "billingStartedAt" timestamptz,
    "billingTimeZone" text,
    "reviewedFullDayBoundaryId" uuid,
    "billingPolicyVersion" text,
    "entryDate" date,
    "entryTimeZone" text,
    "entryDayTreatment" text,
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
    and (
      (
        not is_v4
        and not (item ? 'pricingMode')
        and not (item ? 'commissionTermId')
      )
      or
      (
        is_v4
        and item ? 'pricingMode'
        and item ? 'commissionTermId'
        and line."pricingMode" = store.pricing_mode
        and line."commissionTermId" is not distinct from store.commission_term_id
      )
    )
    and line.rate = store.fee_rate
    and line."listRate" = store.list_rate
    and line."referralDiscountRate" = store.referral_discount_rate
    and line."referralCount" = store.referral_count
    and line.amount = store.fee_amount
    and line."baseAmount" = store.billable_gross_rounded
    and line."sourceGrossAmount" = store.source_gross_rounded
    and line."billingStartBasis" = store.billing_start_basis
    and line."billingStartId" = store.billing_start_id
    and line."billingStartDate" = store.billing_start_date
    and line."billingTimeZone" = store.billing_time_zone
    and (
      (
        store.billing_start_basis = 'observed_google_counter'
        and item ? 'billingStartBaselineAmount'
        and item ? 'billingStartedAt'
        and line."billingStartBaselineAmount" = store.start_baseline_rounded
        and line."billingStartedAt" = store.billing_started_at
        and not (item ? 'reviewedFullDayBoundaryId')
        and not (item ? 'billingPolicyVersion')
        and not (item ? 'entryDate')
        and not (item ? 'entryTimeZone')
        and not (item ? 'entryDayTreatment')
      )
      or
      (
        store.billing_start_basis = 'reviewed_full_day'
        and item ? 'reviewedFullDayBoundaryId'
        and item ? 'billingPolicyVersion'
        and item ? 'entryDate'
        and item ? 'entryTimeZone'
        and item ? 'entryDayTreatment'
        and line."reviewedFullDayBoundaryId" =
              store.reviewed_full_day_boundary_id
        and line."billingPolicyVersion" = store.billing_policy_version
        and line."entryDate" = store.commercial_entry_day
        and line."entryTimeZone" = store.commercial_entry_time_zone
        and line."entryDayTreatment" = store.entry_day_treatment
        and not (item ? 'billingStartBaselineAmount')
        and not (item ? 'billingStartedAt')
      )
    )
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
       select count(*) from (
         select authoritative.account_id
         from public.manual_invoice_authoritative_rows(
           p_client_id, p_period_start, p_period_end
         ) authoritative
         group by authoritative.account_id
         having sum(authoritative.billable_gross_amount) > 0
       ) stores
     ) then
    raise exception 'Settlement lines do not match the reviewed account/referral rate and Google boundary evidence per store.'
      using errcode = '22023';
  end if;

  perform set_config('dropscale.manual_referral_invoice_rpc', 'on', true);
  insert into public.invoices (
    client_id,
    period_start,
    period_end,
    amount,
    currency,
    status,
    due_date,
    line_items,
    amount_remaining,
    issued_at,
    issued_by,
    issue_attempted_at,
    calculation_version,
    referral_discount_term_id,
    billing_recipient
  ) values (
    p_client_id,
    p_period_start,
    p_period_end,
    p_amount,
    'EUR',
    case when p_amount = 0 then 'waived' else 'draft' end,
    case when p_amount = 0 then null else business_day + 7 end,
    p_line_items,
    case when p_amount = 0 then 0 else null end,
    case when p_amount = 0 then now() else null end,
    p_issued_by,
    now(),
    p_calculation_version,
    case when uses_referral_pricing then commercial_term.term_id else null end,
    p_billing_recipient
  ) returning * into created_invoice;

  if uses_referral_pricing and commercial_term.term_id is not null then
    insert into public.invoice_referral_events (
      invoice_id,
      referral_discount_term_id,
      referral_discount_term_item_id
    )
    select created_invoice.id, item.term_id, item.id
    from public.referral_discount_term_items item
    where item.term_id = commercial_term.term_id;

    get diagnostics referral_events_count = row_count;
    if referral_events_count <> commercial_term.referral_count then
      raise exception 'The invoice did not freeze every approved referral grant.'
        using errcode = '22023';
    end if;
  elsif uses_referral_pricing and commercial_term.referral_count <> 0 then
    raise exception 'A default referral term cannot contain grants.'
      using errcode = '22023';
  end if;

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
    case when authoritative.ending_cap_applied
      then round(authoritative.end_deduction_amount, 6)
    end,
    round(authoritative.billable_gross_amount, 6),
    'EUR'
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
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
$function$
;

comment on function public.create_manual_referral_invoice(
  uuid, date, date, numeric, jsonb, jsonb, jsonb, uuid, uuid, text
) is
  'Creates reviewed v3/v4 weekly settlements. V4 resolves an append-only
per-account list-rate term and applies sealed referrals only to 10% stores;
all fee, Google-boundary and collection-revenue-share evidence is revalidated.';

-- V4 is a new immutable invoice family. Extend, never rewrite, the live V3
-- recipient, provenance and waived-settlement guards.
alter table public.invoices
  drop constraint if exists invoices_v3_billing_recipient_check;
alter table public.invoices
  drop constraint if exists invoices_reviewed_billing_recipient_check;
alter table public.invoices
  add constraint invoices_reviewed_billing_recipient_check check (
    calculation_version not in (
      'agency-fee-eur-v3-manual-referrals-google-boundaries',
      'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries'
    )
    or public.is_valid_invoice_billing_recipient(billing_recipient)
  );

create or replace function public.guard_waived_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and new.calculation_version in (
       'agency-fee-eur-v3-manual-referrals-google-boundaries',
       'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries'
     )
     and coalesce(
       current_setting('dropscale.manual_referral_invoice_rpc', true),
       ''
     ) <> 'on' then
    raise exception 'A reviewed agency invoice can be inserted only by its validated creation RPC.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and new.status = 'waived' then
    if new.amount <> 0
       or new.amount_remaining is distinct from 0::numeric
       or new.issued_at is null
       or new.due_date is not null
       or new.calculation_version not in (
         'agency-fee-eur-v3-manual-referrals-google-boundaries',
         'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries'
       )
       or not public.is_valid_invoice_billing_recipient(new.billing_recipient)
       or jsonb_typeof(new.line_items) <> 'array'
       or jsonb_array_length(new.line_items) = 0
       or new.stripe_invoice_id is not null
       or new.stripe_hosted_url is not null
       or new.stripe_invoice_number is not null
       or new.stripe_invoice_pdf is not null then
      raise exception 'A waived settlement must be zero, issued locally and have no Stripe identity.'
        using errcode = '22023';
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'waived' and new is distinct from old then
    raise exception 'A waived settlement is immutable and cannot be sent to Stripe.'
      using errcode = '22023';
  elsif tg_op = 'UPDATE' and new.status = 'waived' and old.status <> 'waived' then
    raise exception 'Only the reviewed creation transaction can create a waived settlement.'
      using errcode = '22023';
  end if;

  return new;
end
$$;

create or replace function public.set_policy_invoice_issuer_kind()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_kind text;
begin
  if new.calculation_version in (
    'agency-fee-eur-v3-manual-referrals-google-boundaries',
    'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries',
    'agency-fee-eur-10-historical-rollover-2026-07-27'
  ) then
    expected_kind := case
      when new.issued_by is null then 'automation'
      else 'admin'
    end;
    if new.issuer_kind is not null and new.issuer_kind <> expected_kind then
      raise exception 'Invoice issuer provenance contradicts issued_by.'
        using errcode = '22023';
    end if;
    new.issuer_kind := expected_kind;
  end if;

  if new.calculation_version =
       'agency-fee-eur-10-historical-rollover-2026-07-27'
     and coalesce(
       current_setting('dropscale.historical_rollover_invoice_rpc', true),
       ''
     ) <> 'on' then
    raise exception 'A historical rollover invoice can be inserted only by its validated automation RPC.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

alter table public.invoices
  drop constraint if exists invoices_policy_issuer_required;
alter table public.invoices
  add constraint invoices_policy_issuer_required check (
    calculation_version not in (
      'agency-fee-eur-v3-manual-referrals-google-boundaries',
      'agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries',
      'agency-fee-eur-10-historical-rollover-2026-07-27'
    )
    or issuer_kind in ('admin', 'automation')
  );
