-- =============================================================================
-- 0036 - Durable, fenced receipts for automatic recurring billing.
--
-- One item represents one eligible client and one closed Monday-Sunday period.
-- Non-terminal items remain retryable without a rolling time limit. Runs are
-- operational receipts; they never store Google/Stripe payloads or secrets.
-- Historical 0035 rollovers remain a separate sealed queue and are represented
-- only by the aggregate historical_rollovers_checked counter on each run.
-- =============================================================================

create table public.billing_automation_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'running'
    constraint billing_automation_runs_status_check
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  issuance_enabled boolean not null,
  seeded_items integer not null default 0 check (seeded_items >= 0),
  claimed_items integer not null default 0 check (claimed_items >= 0),
  issued_items integer not null default 0 check (issued_items >= 0),
  no_charge_items integer not null default 0 check (no_charge_items >= 0),
  blocked_items integer not null default 0 check (blocked_items >= 0),
  historical_rollovers_checked integer not null default 0
    check (historical_rollovers_checked >= 0),
  exact_refresh_requested integer not null default 0
    check (exact_refresh_requested >= 0),
  exact_refresh_completed integer not null default 0
    check (exact_refresh_completed >= 0),
  reconciliation_checked integer not null default 0
    check (reconciliation_checked >= 0),
  reconciliation_updated integer not null default 0
    check (reconciliation_updated >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  constraint billing_automation_runs_finish_check check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  )
);

comment on table public.billing_automation_runs is
  'Service-created operational receipt for one protected automatic billing invocation. It contains counters only, never upstream payloads or credentials.';

create table public.billing_automation_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  period_start date not null
    constraint billing_automation_items_period_monday
    check (extract(isodow from period_start) = 1),
  period_end date not null,
  state text not null default 'pending'
    constraint billing_automation_items_state_check
    check (state in ('pending', 'processing', 'blocked', 'issued', 'no_charge')),
  stage text not null default 'discovered'
    constraint billing_automation_items_stage_check
    check (stage in ('discovered', 'preview', 'google_evidence', 'stripe_issue', 'complete')),
  blocker_code text,
  safe_message text,
  invoice_id uuid references public.invoices (id) on delete restrict,
  amount_snapshot numeric(12, 2),
  billable_spend_snapshot numeric(18, 6),
  evidence_account_count integer not null default 0
    check (evidence_account_count >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_attempted_at timestamptz,
  resolved_at timestamptz,
  last_run_id uuid references public.billing_automation_runs (id) on delete restrict,
  claimed_by_run_id uuid references public.billing_automation_runs (id) on delete restrict,
  claim_version bigint not null default 0 check (claim_version >= 0),
  claim_expires_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint billing_automation_items_client_period_unique
    unique (client_id, period_start),
  constraint billing_automation_items_period_span_check
    check (period_end = period_start + 6),
  constraint billing_automation_items_code_check
    check (
      blocker_code is null
      or blocker_code ~ '^[a-z0-9_]{1,80}$'
    ),
  constraint billing_automation_items_safe_message_check
    check (safe_message is null or length(safe_message) <= 240),
  constraint billing_automation_items_money_check check (
    (amount_snapshot is null or amount_snapshot >= 0)
    and (billable_spend_snapshot is null or billable_spend_snapshot >= 0)
  ),
  constraint billing_automation_items_claim_check check (
    (
      state = 'processing'
      and claimed_by_run_id is not null
      and claim_expires_at is not null
    )
    or (
      state <> 'processing'
      and claimed_by_run_id is null
      and claim_expires_at is null
    )
  ),
  constraint billing_automation_items_resolution_check check (
    (state in ('issued', 'no_charge') and resolved_at is not null)
    or (state not in ('issued', 'no_charge') and resolved_at is null)
  ),
  constraint billing_automation_items_issued_check check (
    state <> 'issued'
    or (
      invoice_id is not null
      and stage = 'complete'
      and blocker_code is null
      and safe_message is null
    )
  ),
  constraint billing_automation_items_no_charge_check check (
    state <> 'no_charge'
    or (
      invoice_id is null
      and stage = 'complete'
      and blocker_code is null
      and safe_message is null
      and amount_snapshot = 0
      and billable_spend_snapshot = 0
      and evidence_account_count > 0
    )
  ),
  constraint billing_automation_items_blocked_check check (
    state <> 'blocked'
    or (blocker_code is not null and safe_message is not null)
  )
);

comment on table public.billing_automation_items is
  'Durable retry queue and current receipt for one eligible client/closed week. Blocked work remains non-terminal and is always reclaimed oldest-first.';
comment on column public.billing_automation_items.safe_message is
  'A short message selected inside a database function from a stable code. Raw Google/Stripe errors, responses and secrets are forbidden.';
comment on column public.billing_automation_items.claim_version is
  'Monotonic fencing generation. A delayed worker cannot overwrite a newer claim.';

create unique index billing_automation_items_invoice_unique
  on public.billing_automation_items (invoice_id)
  where invoice_id is not null;
create index billing_automation_items_retry_order
  on public.billing_automation_items (period_start, first_seen_at, client_id)
  where state in ('pending', 'processing', 'blocked');
create index billing_automation_items_attention_client
  on public.billing_automation_items (client_id, period_start)
  where state in ('pending', 'processing', 'blocked');
create index billing_automation_runs_started_at
  on public.billing_automation_runs (started_at desc);

alter table public.billing_automation_runs enable row level security;
alter table public.billing_automation_items enable row level security;

revoke all on public.billing_automation_runs
  from public, anon, authenticated, service_role;
revoke all on public.billing_automation_items
  from public, anon, authenticated, service_role;
grant select on public.billing_automation_runs to authenticated;
grant select on public.billing_automation_items to authenticated;

create policy billing_automation_runs_admin_read
  on public.billing_automation_runs
  for select using (public.is_admin());
create policy billing_automation_items_admin_read
  on public.billing_automation_items
  for select using (public.is_admin());

create or replace function public.begin_billing_automation_run(
  p_issuance_enabled boolean
)
returns setof public.billing_automation_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can begin an automation run.'
      using errcode = '42501';
  end if;

  -- A worker claim expires after 20 minutes. A run still marked running two
  -- hours later is abandoned telemetry, not active ownership; close it before
  -- creating the next receipt so operators never see a permanent false run.
  update public.billing_automation_runs abandoned
  set
    status = 'failed',
    finished_at = clock_timestamp(),
    error_count = greatest(abandoned.error_count, 1)
  where abandoned.status = 'running'
    and abandoned.started_at < clock_timestamp() - interval '2 hours';

  return query
  insert into public.billing_automation_runs (issuance_enabled)
  values (coalesce(p_issuance_enabled, false))
  returning *;
end
$$;

create or replace function public.seed_billing_automation_items(
  p_run_id uuid,
  p_closed_through date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  seeded_count integer;
  configured_cutover date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can seed automation work.'
      using errcode = '42501';
  end if;
  if p_run_id is null
     or p_closed_through is null
     or extract(isodow from p_closed_through) <> 7 then
    raise exception 'A running automation id and closed Sunday are required.'
      using errcode = '22023';
  end if;
  perform run.id
  from public.billing_automation_runs run
  where run.id = p_run_id and run.status = 'running'
  for update;
  if not found then
    raise exception 'The automation run is not active.' using errcode = 'P0001';
  end if;

  select config.v3_cutover_monday
    into configured_cutover
  from public.manual_referral_billing_config config
  where config.singleton;

  if configured_cutover is null
     or extract(isodow from configured_cutover) <> 1 then
    raise exception 'The automatic billing cutover is missing or invalid.'
      using errcode = 'P0001';
  end if;

  with eligible_accounts as (
    select
      account.client_id,
      billing_start.google_local_date as billing_start_date,
      billing_end.google_local_date as billing_end_date
    from public.ad_accounts account
    join public.portal_clients client
      on client.id = account.client_id
    join public.ad_account_billing_starts billing_start
      on billing_start.ad_account_id = account.id
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = account.id
    where account.status in ('active', 'suspended')
      and client.approval_status in ('approved', 'rejected')
      and not exists (
        select 1
        from public.profiles profile
        where profile.id = client.id and profile.role = 'admin'
      )
      and billing_start.google_local_date <= p_closed_through
      and (
        billing_end.google_local_date is null
        or billing_end.google_local_date >= billing_start.google_local_date
      )
  ),
  eligible_periods as (
    select distinct
      eligible.client_id,
      week_start::date as period_start,
      (week_start::date + 6) as period_end
    from eligible_accounts eligible
    cross join lateral generate_series(
      greatest(
        date_trunc('week', eligible.billing_start_date::timestamp),
        configured_cutover::timestamp
      ),
      date_trunc(
        'week',
        least(
          coalesce(eligible.billing_end_date, p_closed_through),
          p_closed_through
        )::timestamp
      ),
      interval '7 days'
    ) week_start
  )
  insert into public.billing_automation_items (
    client_id,
    period_start,
    period_end
  )
  select
    period.client_id,
    period.period_start,
    period.period_end
  from eligible_periods period
  where not exists (
    -- The positive 2026-07-27 historical policy is issued only by the sealed
    -- 0035 queue. The recurring path must never create a second client/week.
    select 1
    from public.historical_billing_rollovers rollover
    where rollover.client_id = period.client_id
      and rollover.period_start = period.period_start
  )
  on conflict (client_id, period_start) do nothing;

  get diagnostics seeded_count = row_count;

  update public.billing_automation_runs run
  set seeded_items = run.seeded_items + seeded_count
  where run.id = p_run_id and run.status = 'running';

  return seeded_count;
end
$$;

create or replace function public.billing_automation_exact_zero_account_count(
  p_client_id uuid,
  p_period_start date,
  p_period_end date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  account_count integer;
  ready_account_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can verify zero-charge evidence.'
      using errcode = '42501';
  end if;
  if p_client_id is null
     or p_period_start is null
     or p_period_end <> p_period_start + 6
     or extract(isodow from p_period_start) <> 1 then
    raise exception 'An exact client and Monday-Sunday period are required.'
      using errcode = '22023';
  end if;

  -- Match the immutable invoice RPC's lock order. These locks are held until
  -- record_billing_automation_item_result commits, so a concurrent Google sync
  -- cannot insert spend or replace its proof between the €0 check and the
  -- terminal no_charge update.
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.revenue_sources in share row exclusive mode;
  lock table public.commissions in share row exclusive mode;
  lock table public.google_ledger_sync_windows in share row exclusive mode;

  if (
    select count(*)
    from public.revenue_sources source
    where source.name = 'Google Ads Management'
  ) <> 1 then
    raise exception 'The canonical Google billing source is missing or ambiguous.'
      using errcode = 'P0001';
  end if;

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

  if account_count = 0 or ready_account_count <> account_count then
    raise exception 'Every relevant account needs exact complete post-close Google proof.'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.manual_invoice_authoritative_rows(
      p_client_id,
      p_period_start,
      p_period_end
    ) authoritative
    where authoritative.billable_gross_micros <> 0
  ) then
    raise exception 'A no-charge item cannot contain positive billable Google spend.'
      using errcode = 'P0001';
  end if;

  return account_count;
end
$$;

create or replace function public.claim_billing_automation_items(
  p_run_id uuid,
  p_limit integer default 200
)
returns setof public.billing_automation_items
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can claim automation work.'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'A running automation id and claim limit from 1 to 500 are required.'
      using errcode = '22023';
  end if;
  perform run.id
  from public.billing_automation_runs run
  where run.id = p_run_id and run.status = 'running'
  for update;
  if not found then
    raise exception 'The automation run is not active.' using errcode = 'P0001';
  end if;

  return query
  with candidates as (
    select item.id
    from public.billing_automation_items item
    where item.last_run_id is distinct from p_run_id
      and (
        item.state in ('pending', 'blocked')
        or (
          item.state = 'processing'
          and item.claim_expires_at <= clock_timestamp()
        )
      )
    order by item.period_start, item.first_seen_at, item.client_id
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.billing_automation_items item
    set
      state = 'processing',
      stage = 'preview',
      blocker_code = null,
      safe_message = null,
      claimed_by_run_id = p_run_id,
      claim_version = item.claim_version + 1,
      claim_expires_at = clock_timestamp() + interval '20 minutes',
      attempt_count = item.attempt_count + 1,
      last_attempted_at = clock_timestamp(),
      last_run_id = p_run_id,
      updated_at = clock_timestamp()
    from candidates
    where item.id = candidates.id
    returning item.*
  ),
  counted as (
    update public.billing_automation_runs run
    set claimed_items = run.claimed_items + (select count(*) from claimed)
    where run.id = p_run_id and run.status = 'running'
    returning run.id
  )
  select claimed.*
  from claimed
  cross join counted;
end
$$;

create or replace function public.billing_automation_attention_clients()
returns table (client_id uuid, item_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select item.client_id, count(*) as item_count
  from public.billing_automation_items item
  where public.is_admin()
    and item.state in ('pending', 'processing', 'blocked')
  group by item.client_id
$$;

create or replace function public.latest_billing_automation_run()
returns setof public.billing_automation_runs
language sql
stable
security definer
set search_path = public
as $$
  select run.*
  from public.billing_automation_runs run
  where public.is_admin()
  order by run.started_at desc, run.id desc
  limit 1
$$;

create or replace function public.record_billing_automation_item_result(
  p_item_id uuid,
  p_run_id uuid,
  p_claim_version bigint,
  p_state text,
  p_stage text,
  p_code text default null,
  p_invoice_id uuid default null,
  p_amount numeric default null,
  p_billable_spend numeric default null,
  p_evidence_account_count integer default 0
)
returns setof public.billing_automation_items
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.billing_automation_items%rowtype;
  invoice_row public.invoices%rowtype;
  selected_message text;
  exact_account_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can record automation work.'
      using errcode = '42501';
  end if;
  if p_state not in ('blocked', 'issued', 'no_charge')
     or p_stage not in ('preview', 'google_evidence', 'stripe_issue', 'complete')
     or p_evidence_account_count < 0
     or (p_code is not null and p_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'The automation result shape is invalid.' using errcode = '22023';
  end if;

  perform run.id
  from public.billing_automation_runs run
  where run.id = p_run_id and run.status = 'running'
  for update;
  if not found then
    raise exception 'The automation run is not active.' using errcode = 'P0001';
  end if;

  select * into current_item
  from public.billing_automation_items item
  where item.id = p_item_id
  for update;

  if not found
     or current_item.state <> 'processing'
     or current_item.claimed_by_run_id is distinct from p_run_id
     or current_item.claim_version is distinct from p_claim_version then
    raise exception 'The automation item claim was lost.' using errcode = '40001';
  end if;

  if p_state = 'issued' then
    if p_invoice_id is null or p_code is not null or p_stage <> 'complete' then
      raise exception 'An issued item requires one linked invoice and no blocker.'
        using errcode = '22023';
    end if;
    select * into invoice_row
    from public.invoices invoice
    where invoice.id = p_invoice_id;
    if not found
       or invoice_row.client_id <> current_item.client_id
       or invoice_row.period_start <> current_item.period_start
       or invoice_row.period_end <> current_item.period_end
       or invoice_row.issuer_kind not in ('admin', 'automation')
       or (
         invoice_row.status = 'waived'
         and invoice_row.issued_at is null
       )
       or (
         invoice_row.status <> 'waived'
         and invoice_row.stripe_sent_at is null
         and invoice_row.stripe_delivery_assumed_at is null
       )
       or round(invoice_row.amount, 2) is distinct from round(p_amount, 2) then
      raise exception 'The linked invoice is not an issued receipt for this client/week.'
        using errcode = 'P0001';
    end if;
  elsif p_state = 'no_charge' then
    if p_invoice_id is not null
       or p_code is not null
       or p_stage <> 'complete'
       or p_amount is distinct from 0
       or p_billable_spend is distinct from 0
       or p_evidence_account_count < 1 then
      raise exception 'No-charge requires exact complete proof for every relevant account and zero calculated spend.'
        using errcode = 'P0001';
    end if;
    exact_account_count := public.billing_automation_exact_zero_account_count(
      current_item.client_id,
      current_item.period_start,
      current_item.period_end
    );
    if exact_account_count <> p_evidence_account_count then
      raise exception 'The no-charge evidence account count changed during settlement.'
        using errcode = '40001';
    end if;
  elsif p_code is null then
    raise exception 'Blocked work requires a stable blocker code.'
      using errcode = '22023';
  end if;

  if p_state = 'blocked' then
    selected_message := case p_code
      when 'billing_not_started' then 'An immutable billing start is still required.'
      when 'billing_start_mismatch' then 'The immutable billing start needs review.'
      when 'billing_end_mismatch' then 'The immutable billing end needs review.'
      when 'ledger_missing' then 'Exact closed-week Google evidence is not complete yet.'
      when 'ledger_stale' then 'Closed-week Google evidence needs refreshing.'
      when 'evidence_settling' then 'Sunday Google spend is still settling.'
      when 'recipient_invalid' then 'The client billing details need review.'
      when 'referral_term_mismatch' then 'The manual referral term needs review.'
      when 'stripe_not_configured' then 'Live Stripe billing is not ready.'
      when 'issuance_disabled' then 'Automatic invoice issuance is locked.'
      when 'issue_in_progress' then 'Another invoice worker currently owns this client.'
      when 'preview_failed' then 'The closed week could not be calculated.'
      when 'stripe_issue_failed' then 'Stripe invoice delivery needs retrying.'
      else 'Automatic billing needs review.'
    end;
  end if;

  update public.billing_automation_items item
  set
    state = p_state,
    stage = p_stage,
    blocker_code = case when p_state = 'blocked' then p_code else null end,
    safe_message = case when p_state = 'blocked' then selected_message else null end,
    invoice_id = p_invoice_id,
    amount_snapshot = p_amount,
    billable_spend_snapshot = p_billable_spend,
    evidence_account_count = p_evidence_account_count,
    resolved_at = case
      when p_state in ('issued', 'no_charge') then clock_timestamp()
      else null
    end,
    claimed_by_run_id = null,
    claim_expires_at = null,
    last_run_id = p_run_id,
    updated_at = clock_timestamp()
  where item.id = current_item.id;

  update public.billing_automation_runs run
  set
    issued_items = run.issued_items + case when p_state = 'issued' then 1 else 0 end,
    no_charge_items = run.no_charge_items + case when p_state = 'no_charge' then 1 else 0 end,
    blocked_items = run.blocked_items + case when p_state = 'blocked' then 1 else 0 end
  where run.id = p_run_id and run.status = 'running';

  return query
  select item.*
  from public.billing_automation_items item
  where item.id = current_item.id;
end
$$;

create or replace function public.finish_billing_automation_run(
  p_run_id uuid,
  p_status text,
  p_historical_rollovers_checked integer,
  p_exact_refresh_requested integer,
  p_exact_refresh_completed integer,
  p_reconciliation_checked integer,
  p_reconciliation_updated integer,
  p_error_count integer
)
returns setof public.billing_automation_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can finish an automation run.'
      using errcode = '42501';
  end if;
  if p_status not in ('succeeded', 'partial', 'failed')
     or p_historical_rollovers_checked < 0
     or p_exact_refresh_requested < 0
     or p_exact_refresh_completed < 0
     or p_reconciliation_checked < 0
     or p_reconciliation_updated < 0
     or p_error_count < 0 then
    raise exception 'The automation run result is invalid.' using errcode = '22023';
  end if;

  return query
  update public.billing_automation_runs run
  set
    finished_at = clock_timestamp(),
    status = p_status,
    historical_rollovers_checked = p_historical_rollovers_checked,
    exact_refresh_requested = p_exact_refresh_requested,
    exact_refresh_completed = p_exact_refresh_completed,
    reconciliation_checked = p_reconciliation_checked,
    reconciliation_updated = p_reconciliation_updated,
    error_count = p_error_count
  where run.id = p_run_id and run.status = 'running'
  returning *;

  if not found then
    raise exception 'The automation run is missing or already finished.'
      using errcode = '40001';
  end if;
end
$$;

revoke all on function public.begin_billing_automation_run(boolean)
  from public, anon, authenticated;
revoke all on function public.seed_billing_automation_items(uuid, date)
  from public, anon, authenticated;
revoke all on function public.claim_billing_automation_items(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.billing_automation_exact_zero_account_count(
  uuid, date, date
) from public, anon, authenticated;
revoke all on function public.record_billing_automation_item_result(
  uuid, uuid, bigint, text, text, text, uuid, numeric, numeric, integer
) from public, anon, authenticated;
revoke all on function public.finish_billing_automation_run(
  uuid, text, integer, integer, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.billing_automation_attention_clients()
  from public, anon, authenticated;
revoke all on function public.latest_billing_automation_run()
  from public, anon, authenticated;

grant execute on function public.begin_billing_automation_run(boolean)
  to service_role;
grant execute on function public.seed_billing_automation_items(uuid, date)
  to service_role;
grant execute on function public.claim_billing_automation_items(uuid, integer)
  to service_role;
grant execute on function public.billing_automation_exact_zero_account_count(
  uuid, date, date
) to service_role;
grant execute on function public.record_billing_automation_item_result(
  uuid, uuid, bigint, text, text, text, uuid, numeric, numeric, integer
) to service_role;
grant execute on function public.finish_billing_automation_run(
  uuid, text, integer, integer, integer, integer, integer, integer
) to service_role;
grant execute on function public.billing_automation_attention_clients()
  to authenticated;
grant execute on function public.latest_billing_automation_run()
  to authenticated;
