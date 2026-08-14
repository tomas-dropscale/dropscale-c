-- =============================================================================
-- 0034 - Evidence-backed recurring starts for the reviewed pre-v3 policy.
--
-- The exceptional 2026-07-27..2026-08-02 rollover is a separate concern. This
-- migration has no dependency on that rollover and adds the account-level
-- boundary-proof contract required before either historical or recurring
-- Google rows can become billable.
--
-- The two kinds of start are intentionally polymorphic:
--
--   observed_google_counter - the existing live Google capture contract;
--   reviewed_full_day       - the global policy includes the complete Google
--                             reporting day containing the Lisbon entry
--                             instant, with no observed opening counter.
--
-- Europe/Lisbon is only the commercial-entry calendar. Google daily spend is
-- keyed by the account's immutable Google time zone, so a reviewed start is
-- installed only after service-owned live metadata proves that separate date
-- and zone. Unresolved accounts remain unstarted without blocking other ones.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- One row is the immutable, account-level proof. It is deliberately not a
-- child of any historical rollover rows: a zero-spend account may still
-- receive a reviewed start once its own live Google metadata is available.
create table public.reviewed_full_day_billing_boundaries (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique
    references public.ad_accounts (id) on delete restrict,
  client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  google_ads_customer_id text not null
    constraint reviewed_full_day_boundaries_google_customer_format
    check (google_ads_customer_id ~ '^[0-9]{10}$'),
  account_created_at timestamptz not null,
  -- Commercial eligibility always follows the agency's Lisbon calendar.
  entry_day date not null,
  entry_time_zone text not null,
  -- Daily Google ledger rows always follow the account's own reporting zone.
  google_local_date date not null,
  google_time_zone text not null
    constraint reviewed_full_day_boundaries_google_time_zone_present
    check (btrim(google_time_zone) <> ''),
  entry_day_treatment text not null,
  currency text not null,
  cutover_monday date not null,
  policy_version text not null,
  metadata_capture_id uuid not null unique,
  metadata_capture_started_at timestamptz not null,
  metadata_captured_at timestamptz not null,
  metadata_authority text not null,
  metadata_contract text not null,
  source_snapshot jsonb not null,
  source_fingerprint text not null,
  sealed_at timestamptz not null default clock_timestamp(),
  sealed_by text not null default current_user,
  constraint reviewed_full_day_boundaries_fixed_policy check (
    entry_time_zone = 'Europe/Lisbon'
    and entry_day_treatment = 'full-day-inclusive'
    and currency = 'EUR'
    and cutover_monday = date '2026-08-03'
    and policy_version =
      'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2'
    and metadata_authority = 'client_oauth'
    and metadata_contract = 'google-customer-metadata-v1'
  ),
  constraint reviewed_full_day_boundaries_pre_cutover check (
    entry_day = (account_created_at at time zone 'Europe/Lisbon')::date
    and entry_day < cutover_monday
  ),
  constraint reviewed_full_day_boundaries_google_start_day check (
    google_local_date = (account_created_at at time zone google_time_zone)::date
  ),
  constraint reviewed_full_day_boundaries_capture_order check (
    metadata_captured_at >= metadata_capture_started_at
  ),
  constraint reviewed_full_day_boundaries_source_object check (
    jsonb_typeof(source_snapshot) = 'object'
  ),
  constraint reviewed_full_day_boundaries_fingerprint_format check (
    source_fingerprint ~ '^[0-9a-f]{32}$'
  ),
  constraint reviewed_full_day_boundaries_polymorphic_reference unique (
    id,
    ad_account_id,
    google_ads_customer_id,
    google_local_date,
    google_time_zone,
    currency
  )
);

comment on table public.reviewed_full_day_billing_boundaries is
  'Immutable account-level proof separating Europe/Lisbon commercial entry from the real Google reporting day and time zone. It is not a Google counter capture.';
comment on column public.reviewed_full_day_billing_boundaries.entry_day is
  'Commercial entry date derived from account_created_at in Europe/Lisbon.';
comment on column public.reviewed_full_day_billing_boundaries.google_local_date is
  'First complete Google reporting date included by the reviewed policy, derived from account_created_at in the immutable Google account time zone.';
comment on column public.reviewed_full_day_billing_boundaries.metadata_capture_id is
  'Idempotency receipt for the non-secret live Google customer-metadata read.';
comment on column public.reviewed_full_day_billing_boundaries.sealed_by is
  'Database role that committed the evidence-backed policy snapshot; it is not a human reviewer.';

alter table public.reviewed_full_day_billing_boundaries enable row level security;

create policy reviewed_full_day_billing_boundaries_admin_read
  on public.reviewed_full_day_billing_boundaries
  for select using (public.is_admin());

revoke all on public.reviewed_full_day_billing_boundaries
  from public, anon, authenticated, service_role;
grant select on public.reviewed_full_day_billing_boundaries
  to authenticated, service_role;

create or replace function public.guard_reviewed_full_day_boundary_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A reviewed full-day billing boundary is immutable.'
    using errcode = '22023';
end
$$;

create trigger reviewed_full_day_billing_boundaries_guard_immutable
  before update or delete on public.reviewed_full_day_billing_boundaries
  for each row execute function public.guard_reviewed_full_day_boundary_immutable();

do $$
declare
  configured_cutover date;
begin
  select config.v3_cutover_monday
    into configured_cutover
  from public.manual_referral_billing_config config
  where config.singleton;

  if configured_cutover is distinct from date '2026-08-03' then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: the v3 cutover must be the reviewed Monday 2026-08-03.';
  end if;

end
$$;

-- Convert the old one-shape start into a two-shape immutable reference.  The
-- default keeps the existing live-capture RPC source-compatible, while the
-- branch check makes it impossible for an observed start to omit evidence or
-- for a reviewed start to masquerade as an observed zero counter.
alter table public.ad_account_billing_starts
  add column start_basis text not null default 'observed_google_counter',
  add column reviewed_full_day_boundary_id uuid;

alter table public.ad_account_billing_starts
  alter column baseline_cost_micros drop not null,
  alter column capture_started_at drop not null,
  alter column captured_at drop not null,
  alter column capture_id drop not null,
  alter column source drop not null,
  alter column reviewed_by drop not null;

alter table public.ad_account_billing_starts
  add constraint ad_account_billing_starts_basis_check check (
    (
      start_basis = 'observed_google_counter'
      and reviewed_full_day_boundary_id is null
      and baseline_cost_micros is not null
      and capture_started_at is not null
      and captured_at is not null
      and capture_id is not null
      and source = 'agency'
      and reviewed_by is not null
    )
    or
    (
      start_basis = 'reviewed_full_day'
      and reviewed_full_day_boundary_id is not null
      and baseline_cost_micros is null
      and capture_started_at is null
      and captured_at is null
      and capture_id is null
      and source is null
      and reviewed_by is null
    )
  ),
  add constraint ad_account_billing_starts_reviewed_boundary_unique
    unique (reviewed_full_day_boundary_id),
  add constraint ad_account_billing_starts_reviewed_boundary_fkey
    foreign key (
      reviewed_full_day_boundary_id,
      ad_account_id,
      google_ads_customer_id,
      google_local_date,
      google_time_zone,
      currency
    ) references public.reviewed_full_day_billing_boundaries (
      id,
      ad_account_id,
      google_ads_customer_id,
      google_local_date,
      google_time_zone,
      currency
    ) on delete restrict;

comment on column public.ad_account_billing_starts.start_basis is
  'observed_google_counter carries a real live capture; reviewed_full_day references the global pre-v3 full-entry-day proof and carries no observed counter.';
comment on column public.ad_account_billing_starts.reviewed_full_day_boundary_id is
  'Present only for reviewed_full_day. The composite FK binds account, configured Google identity, real Google reporting date/time zone and EUR currency to immutable proof.';

-- This table is written only through the live-capture SECURITY DEFINER RPC or
-- this reviewed migration.  Service workers need SELECT, not direct DML.
revoke insert, update, delete, truncate, references, trigger
  on public.ad_account_billing_starts
  from public, anon, authenticated, service_role;
grant select on public.ad_account_billing_starts
  to authenticated, service_role;

-- Commit one reviewed start only after a live, non-secret Google customer
-- metadata read. This does not read, rotate or revoke OAuth credentials and it
-- never changes the ad-account status. A missing/revoked OAuth connection
-- therefore leaves only this account unstarted.
create or replace function public.commit_reviewed_full_day_billing_start(
  p_account_id uuid,
  p_metadata_capture_id uuid,
  p_google_ads_customer_id text,
  p_google_local_date date,
  p_google_time_zone text,
  p_currency text,
  p_metadata_capture_started_at timestamptz,
  p_metadata_captured_at timestamptz,
  p_metadata_authority text,
  p_metadata_contract text
)
returns setof public.ad_account_billing_starts
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account public.ad_accounts%rowtype;
  target_client public.portal_clients%rowtype;
  existing_boundary public.reviewed_full_day_billing_boundaries%rowtype;
  existing_start public.ad_account_billing_starts%rowtype;
  inserted_boundary public.reviewed_full_day_billing_boundaries%rowtype;
  inserted_start public.ad_account_billing_starts%rowtype;
  configured_cutover date;
  commercial_entry_day date;
  derived_google_local_date date;
  safe_snapshot jsonb;
  fingerprint_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the service role can commit a reviewed full-day billing start.'
      using errcode = '42501';
  end if;

  if p_account_id is null
     or p_metadata_capture_id is null
     or p_google_ads_customer_id is null
     or p_google_ads_customer_id !~ '^[0-9]{10}$'
     or p_google_local_date is null
     or nullif(btrim(p_google_time_zone), '') is null
     or p_currency is null
     or p_currency <> 'EUR'
     or p_metadata_capture_started_at is null
     or p_metadata_captured_at is null
     or p_metadata_captured_at < p_metadata_capture_started_at
     or p_metadata_authority is distinct from 'client_oauth'
     or p_metadata_contract is distinct from 'google-customer-metadata-v1' then
    raise exception 'Invalid authoritative reviewed full-day Google metadata.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from pg_timezone_names zone
    where zone.name = p_google_time_zone
  ) then
    raise exception 'The reviewed Google time zone must be a recognised IANA identifier.'
      using errcode = '22023';
  end if;

  -- The account lock serialises different capture ids racing for the same
  -- immutable start without requiring a migration-wide classification lock.
  select *
    into target_account
  from public.ad_accounts account
  where account.id = p_account_id
  for update;

  if target_account.id is null then
    raise exception 'The target ad account does not exist.'
      using errcode = '22023';
  end if;

  -- A network response may be lost after commit. The capture id makes an exact
  -- replay idempotent but can never be reused with different evidence.
  select *
    into existing_boundary
  from public.reviewed_full_day_billing_boundaries boundary
  where boundary.metadata_capture_id = p_metadata_capture_id
  for update;

  if found then
    if existing_boundary.ad_account_id <> p_account_id
       or existing_boundary.google_ads_customer_id <> p_google_ads_customer_id
       or existing_boundary.google_local_date <> p_google_local_date
       or existing_boundary.google_time_zone <> p_google_time_zone
       or existing_boundary.currency <> p_currency
       or existing_boundary.metadata_capture_started_at <>
            p_metadata_capture_started_at
       or existing_boundary.metadata_captured_at <> p_metadata_captured_at
       or existing_boundary.metadata_authority <> p_metadata_authority
       or existing_boundary.metadata_contract <> p_metadata_contract then
      raise exception 'A metadata capture id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    fingerprint_payload := jsonb_build_object(
      'policyVersion', existing_boundary.policy_version,
      'cutoverMonday', existing_boundary.cutover_monday::text,
      'entryDayTreatment', existing_boundary.entry_day_treatment,
      'sourceSnapshot', existing_boundary.source_snapshot
    );
    if existing_boundary.source_fingerprint <>
         md5(fingerprint_payload::text) then
      raise exception 'The reviewed metadata receipt fingerprint is invalid.'
        using errcode = '22023';
    end if;

    select *
      into strict existing_start
    from public.ad_account_billing_starts billing_start
    where billing_start.reviewed_full_day_boundary_id = existing_boundary.id
      and billing_start.ad_account_id = existing_boundary.ad_account_id
      and billing_start.google_ads_customer_id =
            existing_boundary.google_ads_customer_id
      and billing_start.google_local_date = existing_boundary.google_local_date
      and billing_start.google_time_zone = existing_boundary.google_time_zone
      and billing_start.currency = existing_boundary.currency
      and billing_start.start_basis = 'reviewed_full_day'
      and billing_start.baseline_cost_micros is null
      and billing_start.capture_started_at is null
      and billing_start.captured_at is null
      and billing_start.capture_id is null
      and billing_start.source is null
      and billing_start.reviewed_by is null;

    return next existing_start;
    return;
  end if;

  select *
    into target_client
  from public.portal_clients client
  where client.id = target_account.client_id
  for key share;

  select config.v3_cutover_monday
    into configured_cutover
  from public.manual_referral_billing_config config
  where config.singleton
  for share;

  if configured_cutover is distinct from date '2026-08-03' then
    raise exception 'The v3 cutover is not the reviewed Monday 2026-08-03.'
      using errcode = '22023';
  end if;

  commercial_entry_day :=
    (target_account.created_at at time zone 'Europe/Lisbon')::date;
  derived_google_local_date :=
    (target_account.created_at at time zone p_google_time_zone)::date;

  if target_account.status not in ('active', 'suspended')
     or not target_account.google_ads_connected
     or target_client.id is null
     or target_client.approval_status not in ('approved', 'rejected')
     or exists (
       select 1
       from public.profiles profile
       where profile.id = target_account.client_id
         and profile.role = 'admin'
     )
     or commercial_entry_day >= configured_cutover then
    raise exception 'The target account is not eligible for the reviewed pre-v3 policy.'
      using errcode = '22023';
  end if;

  if target_account.google_ads_customer_id is distinct from
       p_google_ads_customer_id then
    raise exception 'The live Google customer does not match the ad account.'
      using errcode = '22023';
  end if;

  if upper(target_account.currency) is distinct from 'EUR'
     or target_account.list_commission_rate is distinct from 10::numeric
     or target_account.commission_rate is distinct from
          target_account.list_commission_rate
     or target_account.revenue_share_enabled is distinct from false then
    raise exception 'The account is outside the approved 10%% EUR fee-only policy.'
      using errcode = '22023';
  end if;

  if derived_google_local_date <> p_google_local_date then
    raise exception 'The Google start date does not contain the commercial entry instant in the supplied Google time zone.'
      using errcode = '22023';
  end if;

  select *
    into existing_start
  from public.ad_account_billing_starts billing_start
  where billing_start.ad_account_id = target_account.id
  for update;

  if found then
    raise exception 'This ad account already has a different Google billing start.'
      using errcode = '23505';
  end if;

  -- Store an explicit allowlist only. OAuth/Shopify secrets, emails, URLs and
  -- raw provider responses are neither accepted by this RPC nor persisted.
  safe_snapshot := jsonb_build_object(
    'accountId', target_account.id::text,
    'clientId', target_account.client_id::text,
    'storeName', target_account.store_name,
    'googleAdsCustomerId', p_google_ads_customer_id,
    'googleAdsConnected', target_account.google_ads_connected,
    'status', target_account.status,
    'currency', 'EUR',
    'commissionRate', target_account.commission_rate,
    'listCommissionRate', target_account.list_commission_rate,
    'revenueShareEnabled', target_account.revenue_share_enabled,
    'accountCreatedAt', to_char(
      target_account.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'entryDay', commercial_entry_day::text,
    'entryTimeZone', 'Europe/Lisbon',
    'googleLocalDate', p_google_local_date::text,
    'googleTimeZone', p_google_time_zone,
    'metadataCaptureId', p_metadata_capture_id::text,
    'metadataCaptureStartedAt', to_char(
      p_metadata_capture_started_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'metadataCapturedAt', to_char(
      p_metadata_captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'metadataAuthority', p_metadata_authority,
    'metadataContract', p_metadata_contract
  );
  fingerprint_payload := jsonb_build_object(
    'policyVersion',
      'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
    'cutoverMonday', configured_cutover::text,
    'entryDayTreatment', 'full-day-inclusive',
    'sourceSnapshot', safe_snapshot
  );

  insert into public.reviewed_full_day_billing_boundaries (
    ad_account_id,
    client_id,
    google_ads_customer_id,
    account_created_at,
    entry_day,
    entry_time_zone,
    google_local_date,
    google_time_zone,
    entry_day_treatment,
    currency,
    cutover_monday,
    policy_version,
    metadata_capture_id,
    metadata_capture_started_at,
    metadata_captured_at,
    metadata_authority,
    metadata_contract,
    source_snapshot,
    source_fingerprint
  ) values (
    target_account.id,
    target_account.client_id,
    p_google_ads_customer_id,
    target_account.created_at,
    commercial_entry_day,
    'Europe/Lisbon',
    p_google_local_date,
    p_google_time_zone,
    'full-day-inclusive',
    'EUR',
    configured_cutover,
    'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
    p_metadata_capture_id,
    p_metadata_capture_started_at,
    p_metadata_captured_at,
    p_metadata_authority,
    p_metadata_contract,
    safe_snapshot,
    md5(fingerprint_payload::text)
  ) returning * into inserted_boundary;

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
    reviewed_by,
    start_basis,
    reviewed_full_day_boundary_id
  ) values (
    target_account.id,
    p_google_ads_customer_id,
    p_google_local_date,
    p_google_time_zone,
    'EUR',
    null,
    null,
    null,
    null,
    null,
    null,
    'reviewed_full_day',
    inserted_boundary.id
  ) returning * into inserted_start;

  -- Any older proof for this account no longer describes its immutable start.
  delete from public.google_ledger_sync_windows
  where ad_account_id = target_account.id;

  return next inserted_start;
end
$$;

revoke all on function public.commit_reviewed_full_day_billing_start(
  uuid, uuid, text, date, text, text, timestamptz, timestamptz, text, text
) from public, authenticated, anon;
grant execute on function public.commit_reviewed_full_day_billing_start(
  uuid, uuid, text, date, text, text, timestamptz, timestamptz, text, text
) to service_role;

comment on function public.commit_reviewed_full_day_billing_start(
  uuid, uuid, text, date, text, text, timestamptz, timestamptz, text, text
) is
  'Service-only idempotent commit of non-secret live Google metadata, a Lisbon commercial entry and the separate real Google reporting start.';

-- Existing rows are observed starts from 0028. Reviewed rows can only appear
-- through the RPC above, which inserts the boundary and start atomically.
do $$
begin
  if exists (
    select 1
    from public.reviewed_full_day_billing_boundaries boundary
    left join public.ad_account_billing_starts billing_start
      on billing_start.reviewed_full_day_boundary_id = boundary.id
    where billing_start.id is null
       or billing_start.ad_account_id <> boundary.ad_account_id
       or billing_start.start_basis <> 'reviewed_full_day'
       or billing_start.baseline_cost_micros is not null
       or billing_start.capture_started_at is not null
       or billing_start.captured_at is not null
       or billing_start.capture_id is not null
       or billing_start.reviewed_by is not null
       or billing_start.google_local_date <> boundary.google_local_date
       or billing_start.google_time_zone <> boundary.google_time_zone
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: a sealed boundary is missing its exact no-capture polymorphic start.';
  end if;

  if exists (
    select 1
    from public.reviewed_full_day_billing_boundaries boundary
    where boundary.entry_day > date '2026-08-02'
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: a post-cutover account was classified by the historical full-day policy.';
  end if;
end
$$;

-- One authoritative rowset still owns both boundaries.  A reviewed full-day
-- start contributes zero opening deduction because the complete entry day is
-- the policy; NULL remains stored for the nonexistent Google counter.
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
      (
        billing_start.start_basis = 'observed_google_counter'
        and billing_start.google_local_date
              between p_period_start and p_period_end
      ) as opening_baseline_applied,
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
    left join public.reviewed_full_day_billing_boundaries reviewed_boundary
      on reviewed_boundary.id = billing_start.reviewed_full_day_boundary_id
     and reviewed_boundary.ad_account_id = billing_start.ad_account_id
     and reviewed_boundary.google_ads_customer_id =
           billing_start.google_ads_customer_id
     and reviewed_boundary.google_local_date = billing_start.google_local_date
     and reviewed_boundary.google_time_zone = billing_start.google_time_zone
     and reviewed_boundary.currency = billing_start.currency
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
      and (
        (
          billing_start.start_basis = 'observed_google_counter'
          and billing_start.reviewed_full_day_boundary_id is null
          and billing_start.baseline_cost_micros is not null
          and billing_start.captured_at is not null
        )
        or
        (
          billing_start.start_basis = 'reviewed_full_day'
          and reviewed_boundary.id is not null
          and billing_start.baseline_cost_micros is null
          and billing_start.captured_at is null
        )
      )
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

-- The v3 invoice RPC is intentionally kept as the single exact validator.
-- Patch only three audited regions of its catalog-preserved definition: lock
-- the new proof, require a valid branch, and reconstruct branch-specific line
-- provenance.  Abort if upstream SQL no longer contains the exact contract;
-- silently weakening validation would be worse than a failed migration.
do $migration$
declare
  function_signature constant regprocedure :=
    'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure;
  function_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
  block_start_marker constant text :=
    '  -- Reconstruct every visible field and the exact Stripe/local description.';
  block_end_marker constant text :=
    '    and line.label = store.expected_label;';
  block_start integer;
  block_end integer;
  old_block text;
  new_block constant text := $reviewed$
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
      round(exact.source_gross_amount, 2) as source_gross_rounded,
      round(exact.baseline_deduction_amount, 2) as baseline_deduction_rounded,
      round(exact.end_deduction_amount, 2) as end_deduction_rounded,
      round(exact.billable_gross_amount, 2) as billable_gross_rounded,
      case
        when exact.billing_start_basis = 'observed_google_counter'
          then round(exact.start_baseline_micros / 1000000, 2)
      end as start_baseline_rounded,
      round(exact.end_counter_micros / 1000000, 2) as end_counter_rounded,
      round(exact.billable_gross_amount * commercial_term.fee_rate / 100, 2)
        as fee_amount
    from per_store_exact exact
  ), per_store as (
    select
      value.*,
      value.store_name
      || ' - Google Ads agency fee ('
      || public.manual_referral_rate_text(commercial_term.fee_rate)
      || '% of captured Google-reported billable spend: EUR '
      || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
      || '; manual referral term: approved referral count '
      || commercial_term.referral_count::text
      || '; 10% - '
      || public.manual_referral_rate_text(commercial_term.referral_discount_rate)
      || ' percentage points = '
      || public.manual_referral_rate_text(commercial_term.fee_rate)
      || '%'
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
  from jsonb_array_elements(p_line_items) item
  cross join lateral jsonb_to_record(item) as line(
    "accountId" uuid,
    kind text,
    store text,
    label text,
    rate numeric,
    amount numeric,
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
    and line.rate = commercial_term.fee_rate
    and line."listRate" = commercial_term.list_rate
    and line."referralDiscountRate" = commercial_term.referral_discount_rate
    and line."referralCount" = commercial_term.referral_count
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
$reviewed$;
begin
  select pg_get_functiondef(function_signature)
    into function_definition;

  old_fragment :=
    '  lock table public.ad_account_billing_starts in share row exclusive mode;'
    || chr(10)
    || '  lock table public.ad_account_billing_ends in share row exclusive mode;';
  new_fragment :=
    '  lock table public.ad_account_billing_starts in share row exclusive mode;'
    || chr(10)
    || '  lock table public.reviewed_full_day_billing_boundaries in share row exclusive mode;'
    || chr(10)
    || '  lock table public.ad_account_billing_ends in share row exclusive mode;';
  occurrence_count := (
    length(function_definition)
      - length(replace(function_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: the v3 proof-lock fragment changed.';
  end if;
  function_definition := replace(function_definition, old_fragment, new_fragment);

  old_fragment :=
    '      where upper(account.currency) = ''EUR'''
    || chr(10)
    || '        and billing_start.currency = ''EUR'''
    || chr(10)
    || '        and billing_start.google_ads_customer_id = account.google_ads_customer_id'
    || chr(10)
    || '        and not exists (';
  new_fragment :=
    '      where upper(account.currency) = ''EUR'''
    || chr(10)
    || '        and billing_start.currency = ''EUR'''
    || chr(10)
    || '        and billing_start.google_ads_customer_id = account.google_ads_customer_id'
    || chr(10)
    || '        and ('
    || chr(10)
    || '          ('
    || chr(10)
    || '            billing_start.start_basis = ''observed_google_counter'''
    || chr(10)
    || '            and billing_start.reviewed_full_day_boundary_id is null'
    || chr(10)
    || '            and billing_start.baseline_cost_micros is not null'
    || chr(10)
    || '            and billing_start.captured_at is not null'
    || chr(10)
    || '          )'
    || chr(10)
    || '          or exists ('
    || chr(10)
    || '            select 1'
    || chr(10)
    || '            from public.reviewed_full_day_billing_boundaries boundary'
    || chr(10)
    || '            where billing_start.start_basis = ''reviewed_full_day'''
    || chr(10)
    || '              and boundary.id = billing_start.reviewed_full_day_boundary_id'
    || chr(10)
    || '              and boundary.ad_account_id = billing_start.ad_account_id'
    || chr(10)
    || '              and boundary.google_ads_customer_id = billing_start.google_ads_customer_id'
    || chr(10)
    || '              and boundary.google_local_date = billing_start.google_local_date'
    || chr(10)
    || '              and boundary.google_time_zone = billing_start.google_time_zone'
    || chr(10)
    || '              and boundary.currency = billing_start.currency'
    || chr(10)
    || '          )'
    || chr(10)
    || '        )'
    || chr(10)
    || '        and not exists (';
  occurrence_count := (
    length(function_definition)
      - length(replace(function_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: the v3 account-readiness fragment changed.';
  end if;
  function_definition := replace(function_definition, old_fragment, new_fragment);

  block_start := strpos(function_definition, block_start_marker);
  block_end := strpos(function_definition, block_end_marker);
  if block_start = 0
     or block_end = 0
     or block_end <= block_start
     or strpos(
       substring(function_definition from block_start + 1),
       block_start_marker
     ) <> 0
     or strpos(
       substring(function_definition from block_end + 1),
       block_end_marker
     ) <> 0 then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: the v3 line-validator block markers changed.';
  end if;

  block_end := block_end + length(block_end_marker);
  old_block := substring(
    function_definition from block_start for block_end - block_start
  );
  if strpos(
       old_block,
       'billingStartBaselineAmount'
     ) = 0
     or strpos(old_block, 'reviewedFullDayBoundaryId') <> 0 then
    raise exception using
      errcode = 'P0001',
      message = '0034 reviewed starts: the audited v3 line-validator contract changed.';
  end if;

  function_definition :=
    substring(function_definition from 1 for block_start - 1)
    || new_block
    || substring(function_definition from block_end);

  execute function_definition;
end
$migration$;

comment on function public.create_manual_referral_invoice(
  uuid, date, date, numeric, jsonb, jsonb, jsonb, uuid, uuid, text
) is
  'Service-only exact v3 invoice snapshot RPC. Validates either a real observed Google opening counter or an immutable reviewed pre-v3 full-entry-day proof without conflating their provenance.';

notify pgrst, 'reload schema';
