-- 0062 — exact-range read model for provider-expensive admin reporting.
--
-- daily_metrics already owns daily Shopify/Google financial facts. This table
-- deliberately stores only the expensive, range-aggregated provider families
-- used by Admin Campaigns and store Analytics. It is not billing evidence and
-- no billing function reads it.

create table public.admin_reporting_range_snapshots (
  family text not null check (family in (
    'google_campaigns',
    'store_campaign_performance',
    'shopify_funnel',
    'shopify_collection_sales'
  )),
  scope_account_id uuid not null
    references public.ad_accounts(id) on delete cascade,
  from_day date not null,
  to_day date not null,
  authority_key text not null check (authority_key ~ '^[0-9a-f]{64}$'),
  authority_manifest jsonb not null
    check (jsonb_typeof(authority_manifest) = 'object'),
  state text check (state in ('ready', 'partial', 'empty', 'unavailable')),
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'array'),
  message text check (message is null or length(message) between 1 and 1000),
  last_success_at timestamptz,
  last_attempt_at timestamptz not null default now(),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  revision bigint not null default 0 check (revision >= 0),
  primary key (family, scope_account_id, from_day, to_day),
  constraint admin_reporting_snapshot_window check (to_day >= from_day),
  constraint admin_reporting_snapshot_payload check (
    (state is null and payload is null and last_success_at is null)
    or
    (
      state is not null
      and payload is not null
      and last_success_at is not null
      and (
        (state = 'ready' and jsonb_array_length(payload) > 0)
        or
        (state = 'partial')
        or
        (state in ('empty', 'unavailable') and jsonb_array_length(payload) = 0)
      )
    )
  ),
  constraint admin_reporting_snapshot_lease check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

create index admin_reporting_range_snapshots_freshness_idx
  on public.admin_reporting_range_snapshots(last_success_at desc)
  where last_success_at is not null;

comment on table public.admin_reporting_range_snapshots is
  'Service-only, exact-range cache for expensive admin reporting families. Never billing authority.';

alter table public.admin_reporting_range_snapshots enable row level security;
revoke all on table public.admin_reporting_range_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.admin_reporting_range_snapshots to service_role;

create or replace function public.claim_admin_reporting_snapshot_refresh(
  p_family text,
  p_scope_account_id uuid,
  p_from_day date,
  p_to_day date,
  p_authority_key text,
  p_authority_manifest jsonb,
  p_lease_seconds integer default 300
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_token uuid := gen_random_uuid();
  returned_token uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can claim a snapshot refresh.'
      using errcode = '42501';
  end if;
  if p_family not in (
      'google_campaigns', 'store_campaign_performance',
      'shopify_funnel', 'shopify_collection_sales'
    )
    or p_scope_account_id is null
    or p_from_day is null
    or p_to_day is null
    or p_to_day < p_from_day
    or p_to_day > current_date + 1
    or coalesce(p_authority_key, '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_authority_manifest) is distinct from 'object'
    or p_lease_seconds not between 30 and 900
  then
    raise exception 'Invalid admin reporting snapshot refresh claim.'
      using errcode = '22023';
  end if;

  insert into public.admin_reporting_range_snapshots as snapshot (
    family, scope_account_id, from_day, to_day,
    authority_key, authority_manifest,
    last_attempt_at, lease_token, lease_expires_at
  ) values (
    p_family, p_scope_account_id, p_from_day, p_to_day,
    p_authority_key, p_authority_manifest,
    clock_timestamp(), claimed_token,
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  )
  on conflict (family, scope_account_id, from_day, to_day) do update
    set authority_key = excluded.authority_key,
        authority_manifest = excluded.authority_manifest,
        state = case
          when snapshot.authority_key is distinct from excluded.authority_key then null
          else snapshot.state
        end,
        payload = case
          when snapshot.authority_key is distinct from excluded.authority_key then null
          else snapshot.payload
        end,
        message = case
          when snapshot.authority_key is distinct from excluded.authority_key then null
          else snapshot.message
        end,
        last_success_at = case
          when snapshot.authority_key is distinct from excluded.authority_key then null
          else snapshot.last_success_at
        end,
        last_attempt_at = excluded.last_attempt_at,
        last_error_code = case
          when snapshot.authority_key is distinct from excluded.authority_key then null
          else snapshot.last_error_code
        end,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at
    where snapshot.authority_key is distinct from excluded.authority_key
       or snapshot.lease_token is null
       or snapshot.lease_expires_at <= clock_timestamp()
  returning lease_token into returned_token;

  return returned_token;
end
$$;

create or replace function public.complete_admin_reporting_snapshot_refresh(
  p_family text,
  p_scope_account_id uuid,
  p_from_day date,
  p_to_day date,
  p_authority_key text,
  p_lease_token uuid,
  p_state text,
  p_payload jsonb,
  p_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can complete a snapshot refresh.'
      using errcode = '42501';
  end if;
  if p_lease_token is null
    or p_state not in ('ready', 'partial', 'empty', 'unavailable')
    or jsonb_typeof(p_payload) is distinct from 'array'
    or (p_state = 'ready' and jsonb_array_length(p_payload) = 0)
    or (p_state in ('empty', 'unavailable') and jsonb_array_length(p_payload) <> 0)
    or (p_message is not null and length(p_message) not between 1 and 1000)
  then
    raise exception 'Invalid admin reporting snapshot completion.'
      using errcode = '22023';
  end if;

  update public.admin_reporting_range_snapshots snapshot
  set state = p_state,
      payload = p_payload,
      message = p_message,
      last_success_at = clock_timestamp(),
      last_error_code = null,
      lease_token = null,
      lease_expires_at = null,
      revision = snapshot.revision + 1
  where snapshot.family = p_family
    and snapshot.scope_account_id = p_scope_account_id
    and snapshot.from_day = p_from_day
    and snapshot.to_day = p_to_day
    and snapshot.authority_key = p_authority_key
    and snapshot.lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;

create or replace function public.fail_admin_reporting_snapshot_refresh(
  p_family text,
  p_scope_account_id uuid,
  p_from_day date,
  p_to_day date,
  p_authority_key text,
  p_lease_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can fail a snapshot refresh.'
      using errcode = '42501';
  end if;
  if p_lease_token is null
    or coalesce(p_error_code, '') !~ '^[a-z0-9_]{1,80}$'
  then
    raise exception 'Invalid admin reporting snapshot failure.'
      using errcode = '22023';
  end if;

  update public.admin_reporting_range_snapshots snapshot
  set last_error_code = p_error_code,
      lease_token = null,
      lease_expires_at = null
  where snapshot.family = p_family
    and snapshot.scope_account_id = p_scope_account_id
    and snapshot.from_day = p_from_day
    and snapshot.to_day = p_to_day
    and snapshot.authority_key = p_authority_key
    and snapshot.lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;

revoke all on function public.claim_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, uuid, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.fail_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, jsonb, integer
) to service_role;
grant execute on function public.complete_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, uuid, text, jsonb, text
) to service_role;
grant execute on function public.fail_admin_reporting_snapshot_refresh(
  text, uuid, date, date, text, uuid, text
) to service_role;
