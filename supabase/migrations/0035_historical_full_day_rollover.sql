-- =============================================================================
-- 0035 - Automatic, fee-only historical rollover for 2026-07-27..2026-08-02.
--
-- The legacy cutover preserved this week's unissued drafts as `void`, but their
-- commercial formula included terms that are no longer collectible.  This
-- migration seals a new, deterministic source snapshot under the approved
-- global policy:
--
--   * an account enters on the Europe/Lisbon calendar day of created_at;
--   * that complete entry day is billable, including a Sunday entry;
--   * the invoice contains only a 10% EUR agency-fee line;
--   * ad-spend pass-through, revenue share and historical referrals are zero.
--
-- Applying the migration never creates or contacts Stripe and never creates an
-- invoice.  The service-only RPC at the end creates one idempotent local draft
-- per sealed rollover; the ordinary issue worker remains responsible for any
-- later, separately gated Stripe delivery.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- Automation must be represented as automation, not as a synthetic admin.
-- Legacy rows are intentionally left null because absence of an old reviewer
-- is not proof that they were created automatically.
alter table public.invoices
  add column if not exists issuer_kind text;

update public.invoices
set issuer_kind = 'admin'
where issued_by is not null
  and issuer_kind is null;

alter table public.invoices
  drop constraint if exists invoices_issuer_kind_check;
alter table public.invoices
  add constraint invoices_issuer_kind_check
  check (issuer_kind is null or issuer_kind in ('admin', 'automation'));

comment on column public.invoices.issuer_kind is
  'How a reviewed invoice snapshot was created. NULL preserves unknown legacy provenance; admin requires issued_by, automation requires issued_by NULL.';

-- The original absolute uniqueness key is occupied by the preserved legacy
-- void.  Keep that evidence and allow exactly one non-legacy replacement.  A
-- partial key on status would be unsafe because voiding a replacement would
-- reopen the week; version-based uniqueness never does.
do $$
declare
  legacy_unique_constraint text;
begin
  select constraint_row.conname
    into legacy_unique_constraint
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.invoices'::regclass
    and constraint_row.contype = 'u'
    and constraint_row.conkey = array[
      (
        select attribute.attnum::smallint
        from pg_attribute attribute
        where attribute.attrelid = 'public.invoices'::regclass
          and attribute.attname = 'client_id'
      ),
      (
        select attribute.attnum::smallint
        from pg_attribute attribute
        where attribute.attrelid = 'public.invoices'::regclass
          and attribute.attname = 'period_start'
      )
    ]::smallint[]
  limit 1;

  if legacy_unique_constraint is null then
    raise exception using
      errcode = 'P0001',
      message = '0035 rollover: the expected legacy client/week unique constraint is missing.';
  end if;

  execute format(
    'alter table public.invoices drop constraint %I',
    legacy_unique_constraint
  );
end
$$;

create unique index if not exists invoices_one_nonlegacy_per_client_week_idx
  on public.invoices (client_id, period_start)
  where calculation_version <> 'legacy';

-- Dropping the old absolute key must not reopen the legacy namespace. The two
-- complementary partial keys allow one preserved legacy row plus one durable
-- replacement, while still preventing a later writer from manufacturing a
-- second legacy row for the same client/week.
create unique index if not exists invoices_one_legacy_per_client_week_idx
  on public.invoices (client_id, period_start)
  where calculation_version = 'legacy';

create table public.historical_billing_rollovers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  period_start date not null,
  period_end date not null,
  calculation_version text not null,
  currency text not null,
  fee_rate numeric(5,2) not null,
  ad_spend_pass_through_rate numeric(5,2) not null,
  revenue_share_rate numeric(5,2) not null,
  referral_discount_rate numeric(5,2) not null,
  source_gross_amount numeric(18,6) not null,
  amount numeric(12,2) not null,
  line_items jsonb not null,
  source_row_count integer not null,
  account_count integer not null,
  legacy_invoice_ids uuid[] not null default '{}',
  source_fingerprint text not null,
  snapshot_created_at timestamptz not null default clock_timestamp(),
  snapshot_created_by text not null default current_user,
  constraint historical_billing_rollovers_one_client_week
    unique (client_id, period_start),
  constraint historical_billing_rollovers_fixed_week check (
    period_start = date '2026-07-27'
    and period_end = date '2026-08-02'
  ),
  constraint historical_billing_rollovers_fixed_version check (
    calculation_version =
      'agency-fee-eur-10-historical-rollover-2026-07-27'
  ),
  constraint historical_billing_rollovers_fixed_policy check (
    currency = 'EUR'
    and fee_rate = 10::numeric
    and ad_spend_pass_through_rate = 0::numeric
    and revenue_share_rate = 0::numeric
    and referral_discount_rate = 0::numeric
  ),
  constraint historical_billing_rollovers_positive_source check (
    source_gross_amount > 0
    and amount > 0
    and source_row_count > 0
    and account_count > 0
  ),
  constraint historical_billing_rollovers_replaces_legacy check (
    cardinality(legacy_invoice_ids) > 0
  ),
  constraint historical_billing_rollovers_line_items check (
    jsonb_typeof(line_items) = 'array'
    and jsonb_array_length(line_items) > 0
  ),
  constraint historical_billing_rollovers_fingerprint check (
    source_fingerprint ~ '^[0-9a-f]{32}$'
  )
);

comment on table public.historical_billing_rollovers is
  'Immutable migration-time calculation headers for the one approved pre-v3 full-entry-day week. Presence is not an invoice or a Stripe issue attempt.';
comment on column public.historical_billing_rollovers.snapshot_created_by is
  'Database role that installed the global snapshot; it is not a human billing reviewer.';

create table public.historical_billing_rollover_account_proofs (
  rollover_id uuid not null
    references public.historical_billing_rollovers (id) on delete restrict,
  ad_account_id uuid not null
    references public.ad_accounts (id) on delete restrict,
  billing_start_id uuid not null
    references public.ad_account_billing_starts (id) on delete restrict,
  reviewed_full_day_boundary_id uuid not null
    references public.reviewed_full_day_billing_boundaries (id)
    on delete restrict,
  google_ads_customer_id text not null,
  account_created_at timestamptz not null,
  entry_day date not null,
  entry_time_zone text not null,
  google_local_date date not null,
  google_time_zone text not null,
  currency text not null,
  metadata_capture_id uuid not null,
  boundary_source_fingerprint text not null,
  period_start date not null,
  period_end date not null,
  sync_run_id uuid not null,
  sync_started_at timestamptz not null,
  sync_synced_at timestamptz not null,
  sync_ledger_snapshot jsonb not null,
  source_row_count integer not null,
  source_gross_amount numeric(18,6) not null,
  fee_amount numeric(12,2) not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (rollover_id, ad_account_id),
  unique (
    rollover_id,
    ad_account_id,
    billing_start_id,
    reviewed_full_day_boundary_id
  ),
  unique (ad_account_id),
  constraint historical_rollover_account_proofs_boundary_fkey
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
    ) on delete restrict,
  constraint historical_rollover_account_proofs_fixed_week check (
    period_start = date '2026-07-27'
    and period_end = date '2026-08-02'
  ),
  constraint historical_rollover_account_proofs_fixed_policy check (
    entry_time_zone = 'Europe/Lisbon'
    and currency = 'EUR'
    and entry_day =
      (account_created_at at time zone 'Europe/Lisbon')::date
    and google_local_date =
      (account_created_at at time zone google_time_zone)::date
  ),
  constraint historical_rollover_account_proofs_sync_proof check (
    btrim(google_time_zone) <> ''
    and sync_synced_at >= sync_started_at
    and jsonb_typeof(sync_ledger_snapshot) = 'array'
    and source_row_count > 0
    and source_gross_amount > 0
    and fee_amount = round(source_gross_amount * 0.10, 2)
    and boundary_source_fingerprint ~ '^[0-9a-f]{32}$'
  )
);

comment on table public.historical_billing_rollover_account_proofs is
  'Immutable per-account proof binding each historical fee line to a reviewed Google-local start and the exact completed 2026-07-27..2026-08-02 ledger sync generation.';

create table public.historical_billing_rollover_blockers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  ad_account_id uuid
    references public.ad_accounts (id) on delete restrict,
  period_start date not null,
  period_end date not null,
  blocker_code text not null,
  blocks_client_week boolean not null,
  confirmed_row_count integer not null,
  confirmed_gross_amount numeric(18,6) not null,
  evidence jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (client_id, ad_account_id, period_start, blocker_code),
  constraint historical_billing_rollover_blockers_fixed_week check (
    period_start = date '2026-07-27'
    and period_end = date '2026-08-02'
  ),
  constraint historical_billing_rollover_blockers_code check (
    blocker_code in (
      'google_disconnected',
      'reviewed_start_missing',
      'reviewed_start_invalid',
      'reviewed_boundary_missing',
      'reviewed_boundary_invalid',
      'historical_end_requires_review',
      'closed_sync_missing',
      'closed_sync_incomplete',
      'closed_sync_start_mismatch',
      'closed_sync_end_mismatch',
      'closed_sync_not_closed',
      'closed_sync_snapshot_mismatch',
      'invalid_google_ledger_rows',
      'legacy_void_missing',
      'legacy_void_unsafe',
      'existing_nonlegacy_invoice'
    )
  ),
  constraint historical_billing_rollover_blockers_evidence check (
    confirmed_row_count >= 0
    and confirmed_gross_amount >= 0
    and jsonb_typeof(evidence) = 'object'
  )
);

comment on table public.historical_billing_rollover_blockers is
  'Immutable migration-time reasons an account or client/week was excluded. Positive uncertified spend blocks only that client, never another client.';

create table public.historical_billing_rollover_rows (
  rollover_id uuid not null
    references public.historical_billing_rollovers (id) on delete restrict,
  commission_id uuid not null
    references public.commissions (id) on delete restrict,
  ad_account_id uuid not null
    references public.ad_accounts (id) on delete restrict,
  billing_start_id uuid not null
    references public.ad_account_billing_starts (id) on delete restrict,
  reviewed_full_day_boundary_id uuid not null
    references public.reviewed_full_day_billing_boundaries (id)
    on delete restrict,
  sync_run_id uuid not null,
  store_name text not null,
  account_created_at timestamptz not null,
  entry_day date not null,
  google_local_date date not null,
  google_time_zone text not null,
  occurred_on date not null,
  source_gross_amount numeric(18,6) not null,
  billable_gross_amount numeric(18,6) not null,
  currency text not null,
  source_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (rollover_id, commission_id),
  unique (commission_id),
  constraint historical_billing_rollover_rows_account_proof_fkey
    foreign key (
      rollover_id,
      ad_account_id,
      billing_start_id,
      reviewed_full_day_boundary_id
    ) references public.historical_billing_rollover_account_proofs (
      rollover_id,
      ad_account_id,
      billing_start_id,
      reviewed_full_day_boundary_id
    ) on delete restrict,
  constraint historical_billing_rollover_rows_fixed_window check (
    occurred_on between date '2026-07-27' and date '2026-08-02'
    and occurred_on >= google_local_date
  ),
  constraint historical_billing_rollover_rows_full_entry_day check (
    entry_day = (account_created_at at time zone 'Europe/Lisbon')::date
  ),
  constraint historical_billing_rollover_rows_fee_base check (
    currency = 'EUR'
    and btrim(google_time_zone) <> ''
    and source_gross_amount >= 0
    and billable_gross_amount = source_gross_amount
  ),
  constraint historical_billing_rollover_rows_source_object check (
    jsonb_typeof(source_snapshot) = 'object'
  )
);

comment on table public.historical_billing_rollover_rows is
  'Immutable source proof. Full commission gross is billable from the reviewed Google-local entry day; the separate Lisbon date remains commercial-entry evidence only.';

create table public.historical_billing_rollover_issuances (
  rollover_id uuid primary key
    references public.historical_billing_rollovers (id) on delete restrict,
  invoice_id uuid not null unique
    references public.invoices (id) on delete restrict,
  issuer_kind text not null default 'automation'
    constraint historical_billing_rollover_issuances_automation
    check (issuer_kind = 'automation'),
  calculation_version text not null
    constraint historical_billing_rollover_issuances_version check (
      calculation_version =
        'agency-fee-eur-10-historical-rollover-2026-07-27'
    ),
  billing_recipient jsonb not null
    constraint historical_billing_rollover_issuances_recipient check (
      public.is_valid_invoice_billing_recipient(billing_recipient)
    ),
  created_at timestamptz not null default clock_timestamp()
);

comment on table public.historical_billing_rollover_issuances is
  'Append-only receipt linking one sealed rollover to its one automation-created local draft. It records no human reviewer because the policy is global.';

-- Hold every source that participates in the historical classification until
-- the snapshot commits. The new reviewed-start and Google-window locks make
-- the boundary/snapshot classification atomic with the commission snapshot.
lock table
  public.portal_clients,
  public.profiles,
  public.billing_profiles,
  public.ad_accounts,
  public.ad_account_billing_starts,
  public.reviewed_full_day_billing_boundaries,
  public.ad_account_billing_ends,
  public.google_ledger_sync_windows,
  public.revenue_sources,
  public.commissions,
  public.invoices,
  public.manual_billing_cutover_invoice_snapshots
in share row exclusive mode;

-- Classify every otherwise eligible pre-v3 account exactly once. A failed
-- account remains visible in the blocker journal. Only positive spend on an
-- uncertified account blocks its client/week; a disconnected zero-spend
-- account never prevents another account or another client from settling.
create temporary table historical_rollover_account_audit
on commit drop
as
with base_accounts as (
  select
    account.*,
    client.approval_status
  from public.ad_accounts account
  join public.portal_clients client on client.id = account.client_id
  where account.status in ('active', 'suspended')
    and client.approval_status in ('approved', 'rejected')
    and (account.created_at at time zone 'Europe/Lisbon')::date
          < date '2026-08-03'
    and not exists (
      select 1
      from public.profiles profile
      where profile.id = client.id
        and profile.role = 'admin'
    )
)
select
  account.id as ad_account_id,
  account.client_id,
  account.store_name,
  account.created_at as account_created_at,
  account.google_ads_customer_id,
  account.google_ads_connected,
  account.currency as account_currency,
  billing_start.id as billing_start_id,
  billing_start.start_basis,
  billing_start.reviewed_full_day_boundary_id,
  billing_start.google_local_date as start_google_local_date,
  billing_start.google_time_zone as start_google_time_zone,
  billing_start.currency as start_currency,
  billing_start.baseline_cost_micros,
  billing_start.capture_started_at,
  billing_start.captured_at,
  billing_start.capture_id,
  billing_start.source as billing_start_source,
  billing_start.reviewed_by,
  boundary.id as boundary_id,
  boundary.account_created_at as boundary_account_created_at,
  boundary.entry_day,
  boundary.entry_time_zone,
  boundary.google_local_date,
  boundary.google_time_zone,
  boundary.currency as boundary_currency,
  boundary.entry_day_treatment,
  boundary.cutover_monday,
  boundary.policy_version,
  boundary.metadata_capture_id,
  boundary.metadata_capture_started_at,
  boundary.metadata_captured_at,
  boundary.metadata_authority,
  boundary.metadata_contract,
  boundary.source_snapshot as boundary_source_snapshot,
  boundary.source_fingerprint as boundary_source_fingerprint,
  boundary.sealed_at as boundary_sealed_at,
  billing_end.id as billing_end_id,
  billing_end.google_local_date as billing_end_date,
  sync.run_id as sync_run_id,
  sync.billing_start_id as sync_billing_start_id,
  sync.billing_end_id as sync_billing_end_id,
  sync.status as sync_status,
  sync.started_at as sync_started_at,
  sync.synced_at as sync_synced_at,
  sync.ledger_snapshot as sync_ledger_snapshot,
  coalesce(full_week.confirmed_row_count, 0)::integer
    as full_week_confirmed_row_count,
  coalesce(full_week.positive_gross_amount, 0)::numeric(18,6)
    as full_week_positive_gross_amount,
  coalesce(current_ledger.source_row_count, 0)::integer
    as source_row_count,
  coalesce(current_ledger.source_gross_amount, 0)::numeric(18,6)
    as source_gross_amount,
  coalesce(current_ledger.invalid_row_count, 0)::integer
    as invalid_row_count,
  coalesce(current_ledger.ledger_snapshot, '[]'::jsonb)
    as current_ledger_snapshot,
  case
    when account.google_ads_connected is distinct from true then
      'google_disconnected'
    when billing_start.id is null then
      'reviewed_start_missing'
    when billing_start.start_basis is distinct from 'reviewed_full_day'
      or billing_start.reviewed_full_day_boundary_id is null
      or billing_start.google_ads_customer_id is distinct from
           account.google_ads_customer_id
      or billing_start.currency is distinct from 'EUR'
      or billing_start.baseline_cost_micros is not null
      or billing_start.capture_started_at is not null
      or billing_start.captured_at is not null
      or billing_start.capture_id is not null
      or billing_start.source is not null
      or billing_start.reviewed_by is not null then
      'reviewed_start_invalid'
    when boundary.id is null then
      'reviewed_boundary_missing'
    when boundary.ad_account_id is distinct from account.id
      or boundary.client_id is distinct from account.client_id
      or boundary.google_ads_customer_id is distinct from
           account.google_ads_customer_id
      or boundary.account_created_at is distinct from account.created_at
      or boundary.entry_day is distinct from
           (account.created_at at time zone 'Europe/Lisbon')::date
      or boundary.entry_time_zone is distinct from 'Europe/Lisbon'
      or boundary.google_local_date is distinct from case
           when exists (
             select 1
             from pg_timezone_names safe_zone
             where safe_zone.name = boundary.google_time_zone
           ) then
             (account.created_at at time zone boundary.google_time_zone)::date
         end
      or boundary.google_local_date is distinct from
           billing_start.google_local_date
      or boundary.google_time_zone is distinct from
           billing_start.google_time_zone
      or boundary.currency is distinct from 'EUR'
      or boundary.entry_day_treatment is distinct from 'full-day-inclusive'
      or boundary.cutover_monday is distinct from date '2026-08-03'
      or boundary.policy_version is distinct from
           'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2'
      or boundary.metadata_authority is distinct from 'client_oauth'
      or boundary.metadata_contract is distinct from
           'google-customer-metadata-v1'
      or boundary.metadata_captured_at < boundary.metadata_capture_started_at
      or boundary.sealed_at < boundary.metadata_captured_at
      or not exists (
        select 1
        from pg_timezone_names zone
        where zone.name = boundary.google_time_zone
      )
      or boundary.source_fingerprint is distinct from md5(
        jsonb_build_object(
          'policyVersion', boundary.policy_version,
          'cutoverMonday', boundary.cutover_monday::text,
          'entryDayTreatment', boundary.entry_day_treatment,
          'sourceSnapshot', boundary.source_snapshot
        )::text
      )
      or upper(account.currency) is distinct from 'EUR'
      or account.list_commission_rate is distinct from 10::numeric
      or account.commission_rate is distinct from
           account.list_commission_rate
      or account.revenue_share_enabled is distinct from false then
      'reviewed_boundary_invalid'
    when coalesce(current_ledger.invalid_row_count, 0) <> 0 then
      'invalid_google_ledger_rows'
    when billing_end.google_local_date between
           date '2026-07-27' and date '2026-08-02' then
      'historical_end_requires_review'
    when sync.ad_account_id is null then
      'closed_sync_missing'
    when sync.status is distinct from 'complete' then
      'closed_sync_incomplete'
    when sync.billing_start_id is distinct from billing_start.id then
      'closed_sync_start_mismatch'
    when not (
      sync.billing_end_id is not distinct from billing_end.id
      or (
        billing_end.google_local_date > date '2026-08-02'
        and sync.billing_end_id is null
      )
    ) then
      'closed_sync_end_mismatch'
    when sync.started_at is null
      or sync.synced_at is null
      or sync.synced_at < sync.started_at
      or (sync.synced_at at time zone billing_start.google_time_zone)::date
           <= date '2026-08-02' then
      'closed_sync_not_closed'
    when sync.ledger_snapshot is distinct from
           coalesce(current_ledger.ledger_snapshot, '[]'::jsonb) then
      'closed_sync_snapshot_mismatch'
  end as blocker_code
from base_accounts account
left join public.ad_account_billing_starts billing_start
  on billing_start.ad_account_id = account.id
left join public.reviewed_full_day_billing_boundaries boundary
  on boundary.id = billing_start.reviewed_full_day_boundary_id
left join public.ad_account_billing_ends billing_end
  on billing_end.ad_account_id = account.id
 and billing_end.billing_start_id = billing_start.id
 and billing_end.google_ads_customer_id =
       billing_start.google_ads_customer_id
 and billing_end.google_time_zone = billing_start.google_time_zone
 and billing_end.currency = billing_start.currency
left join public.google_ledger_sync_windows sync
  on sync.ad_account_id = account.id
 and sync.period_start = date '2026-07-27'
 and sync.period_end = date '2026-08-02'
left join lateral (
  select
    count(*)::integer as confirmed_row_count,
    coalesce(
      sum(commission.gross_amount)
        filter (where commission.gross_amount > 0),
      0
    )::numeric(18,6) as positive_gross_amount
  from public.commissions commission
  join public.revenue_sources source on source.id = commission.source_id
  where commission.ad_account_id = account.id
    and source.name = 'Google Ads Management'
    and commission.status = 'confirmed'
    and commission.occurred_on between
      date '2026-07-27' and date '2026-08-02'
) full_week on true
left join lateral (
  select
    count(*)::integer as source_row_count,
    coalesce(sum(commission.gross_amount), 0)::numeric(18,6)
      as source_gross_amount,
    count(*) filter (
      where upper(commission.currency) is distinct from 'EUR'
         or commission.gross_amount < 0
    )::integer as invalid_row_count,
    coalesce(
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
        )
        order by commission.id
      ),
      '[]'::jsonb
    ) as ledger_snapshot
  from public.commissions commission
  join public.revenue_sources source on source.id = commission.source_id
  where commission.ad_account_id = account.id
    and source.name = 'Google Ads Management'
    and commission.status = 'confirmed'
    and commission.occurred_on between
      greatest(date '2026-07-27', billing_start.google_local_date)
      and least(
        date '2026-08-02',
        coalesce(billing_end.google_local_date, date '2026-08-02')
      )
) current_ledger on billing_start.id is not null;

create unique index historical_rollover_account_audit_account_idx
  on historical_rollover_account_audit (ad_account_id);

insert into public.historical_billing_rollover_blockers (
  client_id,
  ad_account_id,
  period_start,
  period_end,
  blocker_code,
  blocks_client_week,
  confirmed_row_count,
  confirmed_gross_amount,
  evidence
)
select
  audit.client_id,
  audit.ad_account_id,
  date '2026-07-27',
  date '2026-08-02',
  audit.blocker_code,
  audit.full_week_positive_gross_amount > 0,
  audit.full_week_confirmed_row_count,
  audit.full_week_positive_gross_amount,
  jsonb_build_object(
    'accountId', audit.ad_account_id::text,
    'storeName', audit.store_name,
    'googleAdsCustomerId', audit.google_ads_customer_id,
    'googleAdsConnected', audit.google_ads_connected,
    'billingStartId', audit.billing_start_id,
    'reviewedFullDayBoundaryId', audit.boundary_id,
    'googleLocalDate', audit.google_local_date,
    'googleTimeZone', audit.google_time_zone,
    'syncRunId', audit.sync_run_id,
    'syncStatus', audit.sync_status,
    'fullWeekConfirmedRowCount', audit.full_week_confirmed_row_count,
    'fullWeekPositiveGrossAmount', audit.full_week_positive_gross_amount
  )
from historical_rollover_account_audit audit
where audit.blocker_code is not null;

-- Rows from certified accounts are still provisional until the whole client is
-- checked. A positive uncertified sibling account blocks this client/week, but
-- zero-spend unresolved siblings remain only informational blockers.
create temporary table historical_rollover_certified_rows
on commit drop
as
select
  commission.id as commission_id,
  account.ad_account_id,
  account.client_id,
  account.store_name,
  account.account_created_at,
  account.entry_day,
  account.entry_time_zone,
  account.google_local_date,
  account.google_time_zone,
  account.billing_start_id,
  account.boundary_id as reviewed_full_day_boundary_id,
  account.sync_run_id,
  round(commission.gross_amount, 6) as source_gross_amount,
  upper(commission.currency) as currency,
  commission.occurred_on,
  to_jsonb(commission) as source_snapshot
from historical_rollover_account_audit account
join public.commissions commission
  on commission.ad_account_id = account.ad_account_id
join public.revenue_sources source on source.id = commission.source_id
where account.blocker_code is null
  and source.name = 'Google Ads Management'
  and commission.status = 'confirmed'
  and upper(commission.currency) = 'EUR'
  and commission.gross_amount >= 0
  and commission.occurred_on between
    greatest(date '2026-07-27', account.google_local_date)
    and date '2026-08-02'
  and not exists (
    select 1
    from public.historical_billing_rollover_blockers blocker
    where blocker.client_id = account.client_id
      and blocker.period_start = date '2026-07-27'
      and blocker.blocks_client_week
  );

create temporary table historical_rollover_billable_accounts
on commit drop
as
select
  audit.ad_account_id,
  audit.client_id,
  audit.store_name,
  audit.account_created_at,
  audit.google_ads_customer_id,
  audit.billing_start_id,
  audit.boundary_id as reviewed_full_day_boundary_id,
  audit.entry_day,
  audit.entry_time_zone,
  audit.google_local_date,
  audit.google_time_zone,
  audit.metadata_capture_id,
  audit.boundary_source_fingerprint,
  audit.sync_run_id,
  audit.sync_started_at,
  audit.sync_synced_at,
  audit.sync_ledger_snapshot,
  count(row.commission_id)::integer as source_row_count,
  round(sum(row.source_gross_amount), 6) as source_gross_amount,
  round(sum(row.source_gross_amount) * 0.10, 2) as fee_amount
from historical_rollover_account_audit audit
join historical_rollover_certified_rows row
  on row.ad_account_id = audit.ad_account_id
group by
  audit.ad_account_id,
  audit.client_id,
  audit.store_name,
  audit.account_created_at,
  audit.google_ads_customer_id,
  audit.billing_start_id,
  audit.boundary_id,
  audit.entry_day,
  audit.entry_time_zone,
  audit.google_local_date,
  audit.google_time_zone,
  audit.metadata_capture_id,
  audit.boundary_source_fingerprint,
  audit.sync_run_id,
  audit.sync_started_at,
  audit.sync_synced_at,
  audit.sync_ledger_snapshot
having sum(row.source_gross_amount) > 0;

-- Invoice replacement safety is also isolated per client. A missing/unsafe
-- legacy void consumes no new uniqueness slot and cannot stop safe clients.
with candidate_clients as (
  select
    account.client_id,
    sum(account.source_row_count)::integer as source_row_count,
    round(sum(account.source_gross_amount), 6) as source_gross_amount,
    sum(account.fee_amount) as fee_amount
  from historical_rollover_billable_accounts account
  group by account.client_id
  having sum(account.fee_amount) > 0
), legacy_audit as (
  select
    candidate.*,
    count(invoice.id) filter (
      where invoice.calculation_version <> 'legacy'
    )::integer as nonlegacy_count,
    count(invoice.id) filter (
      where invoice.calculation_version = 'legacy'
    )::integer as legacy_count,
    count(invoice.id) filter (
      where invoice.calculation_version = 'legacy'
        and invoice.period_end = date '2026-08-02'
        and invoice.status = 'void'
        and invoice.issued_at is null
        and invoice.stripe_invoice_id is null
        and invoice.stripe_hosted_url is null
        and invoice.stripe_invoice_number is null
        and invoice.stripe_invoice_pdf is null
        and invoice.paid_at is null
        and invoice.payment_failed_at is null
        and invoice.stripe_sent_at is null
        and invoice.stripe_delivery_assumed_at is null
        and archived.invoice_id is not null
        and archived.snapshot->>'id' = invoice.id::text
        and archived.snapshot->>'client_id' = invoice.client_id::text
        and archived.snapshot->>'period_start' = invoice.period_start::text
        and archived.snapshot->>'period_end' = invoice.period_end::text
        and (archived.snapshot->>'amount')::numeric = invoice.amount
        and archived.snapshot->>'currency' = invoice.currency
        and archived.snapshot->'line_items' = invoice.line_items
        and archived.snapshot->>'calculation_version' = 'legacy'
        and archived.snapshot->>'status' = 'draft'
        and archived.snapshot->>'stripe_invoice_id' is null
        and archived.snapshot->>'issued_at' is null
    )::integer as safe_legacy_count
  from candidate_clients candidate
  left join public.invoices invoice
    on invoice.client_id = candidate.client_id
   and invoice.period_start = date '2026-07-27'
  left join public.manual_billing_cutover_invoice_snapshots archived
    on archived.invoice_id = invoice.id
  group by
    candidate.client_id,
    candidate.source_row_count,
    candidate.source_gross_amount,
    candidate.fee_amount
)
insert into public.historical_billing_rollover_blockers (
  client_id,
  ad_account_id,
  period_start,
  period_end,
  blocker_code,
  blocks_client_week,
  confirmed_row_count,
  confirmed_gross_amount,
  evidence
)
select
  legacy.client_id,
  null,
  date '2026-07-27',
  date '2026-08-02',
  case
    when legacy.nonlegacy_count > 0 then 'existing_nonlegacy_invoice'
    when legacy.legacy_count = 0 then 'legacy_void_missing'
    else 'legacy_void_unsafe'
  end,
  true,
  legacy.source_row_count,
  legacy.source_gross_amount,
  jsonb_build_object(
    'nonLegacyInvoiceCount', legacy.nonlegacy_count,
    'legacyInvoiceCount', legacy.legacy_count,
    'safeLegacyInvoiceCount', legacy.safe_legacy_count,
    'certifiedFeeAmount', legacy.fee_amount
  )
from legacy_audit legacy
where legacy.nonlegacy_count > 0
   or legacy.legacy_count = 0
   or legacy.safe_legacy_count <> legacy.legacy_count;

-- Build one deterministic fee line per proven account. Fees are rounded per
-- account before being summed for the client, preserving the reviewed cents.
with eligible_accounts as (
  select account.*
  from historical_rollover_billable_accounts account
  where not exists (
    select 1
    from public.historical_billing_rollover_blockers blocker
    where blocker.client_id = account.client_id
      and blocker.period_start = date '2026-07-27'
      and blocker.blocks_client_week
  )
), positive_clients as (
  select client_id
  from eligible_accounts
  group by client_id
  having sum(fee_amount) > 0
), headers as (
  select
    account.client_id,
    round(sum(account.source_gross_amount), 6) as source_gross_amount,
    sum(account.fee_amount) as amount,
    jsonb_agg(
      jsonb_build_object(
        'kind', 'fee',
        'accountId', account.ad_account_id::text,
        'store', account.store_name,
        'rate', 10,
        'baseAmount', round(account.source_gross_amount, 2),
        'sourceGrossAmount', account.source_gross_amount,
        'amount', account.fee_amount,
        'billingStartBasis', 'reviewed_full_day',
        'billingStartId', account.billing_start_id::text,
        'reviewedFullDayBoundaryId',
          account.reviewed_full_day_boundary_id::text,
        'billingPolicyVersion',
          'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
        'entryDate', account.entry_day::text,
        'entryTimeZone', account.entry_time_zone,
        'billingStartDate', account.google_local_date::text,
        'billingTimeZone', account.google_time_zone,
        'entryDayTreatment', 'full-day-inclusive',
        'ledgerPeriodStart', '2026-07-27',
        'ledgerPeriodEnd', '2026-08-02',
        'ledgerSyncRunId', account.sync_run_id::text,
        'ledgerSyncedAt', account.sync_synced_at,
        'adSpendPassThroughAmount', 0,
        'revenueShareAmount', 0,
        'referralDiscountAmount', 0,
        'label', account.store_name
          || ' - Google Ads agency fee (10% of Google-reported spend: EUR '
          || to_char(
               account.source_gross_amount,
               'FM999999999999999990.000000'
             )
          || '; full '
          || account.google_time_zone
          || ' Google reporting day '
          || account.google_local_date::text
          || ' included; commercial entry '
          || account.entry_day::text
          || ' in Europe/Lisbon; certified through Sunday 2026-08-02; no ad-spend pass-through, revenue share or historical referral discount)'
      )
      order by account.ad_account_id
    ) as line_items,
    sum(account.source_row_count)::integer as source_row_count,
    count(*)::integer as account_count
  from eligible_accounts account
  join positive_clients client on client.client_id = account.client_id
  group by account.client_id
), proof_payloads as (
  select
    account.client_id,
    jsonb_agg(
      jsonb_build_object(
        'adAccountId', account.ad_account_id::text,
        'billingStartId', account.billing_start_id::text,
        'reviewedFullDayBoundaryId',
          account.reviewed_full_day_boundary_id::text,
        'googleAdsCustomerId', account.google_ads_customer_id,
        'accountCreatedAt', account.account_created_at,
        'entryDay', account.entry_day::text,
        'entryTimeZone', account.entry_time_zone,
        'googleLocalDate', account.google_local_date::text,
        'googleTimeZone', account.google_time_zone,
        'metadataCaptureId', account.metadata_capture_id::text,
        'boundarySourceFingerprint', account.boundary_source_fingerprint,
        'syncRunId', account.sync_run_id::text,
        'syncStartedAt', account.sync_started_at,
        'syncSyncedAt', account.sync_synced_at,
        'syncLedgerSnapshot', account.sync_ledger_snapshot,
        'sourceRowCount', account.source_row_count,
        'sourceGrossAmount', account.source_gross_amount,
        'feeAmount', account.fee_amount
      ) order by account.ad_account_id
    ) as account_proofs
  from eligible_accounts account
  join positive_clients client on client.client_id = account.client_id
  group by account.client_id
), fingerprints as (
  select
    row.client_id,
    md5(
      jsonb_build_object(
        'calculationVersion',
          'agency-fee-eur-10-historical-rollover-2026-07-27',
        'periodStart', '2026-07-27',
        'periodEnd', '2026-08-02',
        'feeRate', 10,
        'adSpendPassThroughRate', 0,
        'revenueShareRate', 0,
        'referralDiscountRate', 0,
        'accountProofs', proof.account_proofs,
        'rows', jsonb_agg(
          jsonb_build_object(
            'commissionId', row.commission_id::text,
            'adAccountId', row.ad_account_id::text,
            'billingStartId', row.billing_start_id::text,
            'reviewedFullDayBoundaryId',
              row.reviewed_full_day_boundary_id::text,
            'syncRunId', row.sync_run_id::text,
            'accountCreatedAt', row.account_created_at,
            'entryDay', row.entry_day::text,
            'googleLocalDate', row.google_local_date::text,
            'googleTimeZone', row.google_time_zone,
            'occurredOn', row.occurred_on::text,
            'sourceGrossAmount', row.source_gross_amount,
            'currency', row.currency,
            'sourceSnapshot', row.source_snapshot
          )
          order by row.commission_id
        )
      )::text
    ) as source_fingerprint
  from historical_rollover_certified_rows row
  join eligible_accounts account on account.ad_account_id = row.ad_account_id
  join positive_clients client on client.client_id = row.client_id
  join proof_payloads proof on proof.client_id = row.client_id
  group by row.client_id, proof.account_proofs
), legacy as (
  select
    client.client_id,
    array_agg(invoice.id order by invoice.id) as legacy_invoice_ids
  from positive_clients client
  join public.invoices invoice
    on invoice.client_id = client.client_id
   and invoice.period_start = date '2026-07-27'
   and invoice.calculation_version = 'legacy'
  group by client.client_id
)
insert into public.historical_billing_rollovers (
  client_id,
  period_start,
  period_end,
  calculation_version,
  currency,
  fee_rate,
  ad_spend_pass_through_rate,
  revenue_share_rate,
  referral_discount_rate,
  source_gross_amount,
  amount,
  line_items,
  source_row_count,
  account_count,
  legacy_invoice_ids,
  source_fingerprint
)
select
  header.client_id,
  date '2026-07-27',
  date '2026-08-02',
  'agency-fee-eur-10-historical-rollover-2026-07-27',
  'EUR',
  10,
  0,
  0,
  0,
  header.source_gross_amount,
  header.amount,
  header.line_items,
  header.source_row_count,
  header.account_count,
  legacy.legacy_invoice_ids,
  fingerprint.source_fingerprint
from headers header
join fingerprints fingerprint on fingerprint.client_id = header.client_id
join legacy on legacy.client_id = header.client_id;

insert into public.historical_billing_rollover_account_proofs (
  rollover_id,
  ad_account_id,
  billing_start_id,
  reviewed_full_day_boundary_id,
  google_ads_customer_id,
  account_created_at,
  entry_day,
  entry_time_zone,
  google_local_date,
  google_time_zone,
  currency,
  metadata_capture_id,
  boundary_source_fingerprint,
  period_start,
  period_end,
  sync_run_id,
  sync_started_at,
  sync_synced_at,
  sync_ledger_snapshot,
  source_row_count,
  source_gross_amount,
  fee_amount
)
select
  rollover.id,
  account.ad_account_id,
  account.billing_start_id,
  account.reviewed_full_day_boundary_id,
  account.google_ads_customer_id,
  account.account_created_at,
  account.entry_day,
  account.entry_time_zone,
  account.google_local_date,
  account.google_time_zone,
  'EUR',
  account.metadata_capture_id,
  account.boundary_source_fingerprint,
  date '2026-07-27',
  date '2026-08-02',
  account.sync_run_id,
  account.sync_started_at,
  account.sync_synced_at,
  account.sync_ledger_snapshot,
  account.source_row_count,
  account.source_gross_amount,
  account.fee_amount
from historical_rollover_billable_accounts account
join public.historical_billing_rollovers rollover
  on rollover.client_id = account.client_id;

insert into public.historical_billing_rollover_rows (
  rollover_id,
  commission_id,
  ad_account_id,
  billing_start_id,
  reviewed_full_day_boundary_id,
  sync_run_id,
  store_name,
  account_created_at,
  entry_day,
  google_local_date,
  google_time_zone,
  occurred_on,
  source_gross_amount,
  billable_gross_amount,
  currency,
  source_snapshot
)
select
  rollover.id,
  row.commission_id,
  row.ad_account_id,
  row.billing_start_id,
  row.reviewed_full_day_boundary_id,
  row.sync_run_id,
  row.store_name,
  row.account_created_at,
  row.entry_day,
  row.google_local_date,
  row.google_time_zone,
  row.occurred_on,
  row.source_gross_amount,
  row.source_gross_amount,
  'EUR',
  row.source_snapshot
from historical_rollover_certified_rows row
join public.historical_billing_rollovers rollover
  on rollover.client_id = row.client_id
join public.historical_billing_rollover_account_proofs proof
  on proof.rollover_id = rollover.id
 and proof.ad_account_id = row.ad_account_id
 and proof.billing_start_id = row.billing_start_id
 and proof.reviewed_full_day_boundary_id =
       row.reviewed_full_day_boundary_id;

-- The known live rollout total is deliberately checked in the credentialed
-- pre-apply audit, not hard-coded into a reusable migration that must also be
-- valid for empty/dev databases. The relational checks below nevertheless
-- make the dynamic total exact: headers equal the sum of their account-rounded
-- fee proofs and their immutable line items.
-- Recalculate the canonical row proof from the sealed relational snapshot.
-- MD5 is used only as a compact accidental-change fingerprint; write
-- privileges and immutable triggers, not collision resistance, are the
-- security boundary.
create or replace function public.historical_billing_rollover_fingerprint(
  p_rollover_id uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select md5(
    jsonb_build_object(
      'calculationVersion',
        'agency-fee-eur-10-historical-rollover-2026-07-27',
      'periodStart', '2026-07-27',
      'periodEnd', '2026-08-02',
      'feeRate', 10,
      'adSpendPassThroughRate', 0,
      'revenueShareRate', 0,
      'referralDiscountRate', 0,
      'accountProofs', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'adAccountId', proof.ad_account_id::text,
              'billingStartId', proof.billing_start_id::text,
              'reviewedFullDayBoundaryId',
                proof.reviewed_full_day_boundary_id::text,
              'googleAdsCustomerId', proof.google_ads_customer_id,
              'accountCreatedAt', proof.account_created_at,
              'entryDay', proof.entry_day::text,
              'entryTimeZone', proof.entry_time_zone,
              'googleLocalDate', proof.google_local_date::text,
              'googleTimeZone', proof.google_time_zone,
              'metadataCaptureId', proof.metadata_capture_id::text,
              'boundarySourceFingerprint',
                proof.boundary_source_fingerprint,
              'syncRunId', proof.sync_run_id::text,
              'syncStartedAt', proof.sync_started_at,
              'syncSyncedAt', proof.sync_synced_at,
              'syncLedgerSnapshot', proof.sync_ledger_snapshot,
              'sourceRowCount', proof.source_row_count,
              'sourceGrossAmount', proof.source_gross_amount,
              'feeAmount', proof.fee_amount
            ) order by proof.ad_account_id
          )
          from public.historical_billing_rollover_account_proofs proof
          where proof.rollover_id = p_rollover_id
        ),
        '[]'::jsonb
      ),
      'rows', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'commissionId', row.commission_id::text,
            'adAccountId', row.ad_account_id::text,
            'billingStartId', row.billing_start_id::text,
            'reviewedFullDayBoundaryId',
              row.reviewed_full_day_boundary_id::text,
            'syncRunId', row.sync_run_id::text,
            'accountCreatedAt', row.account_created_at,
            'entryDay', row.entry_day::text,
            'googleLocalDate', row.google_local_date::text,
            'googleTimeZone', row.google_time_zone,
            'occurredOn', row.occurred_on::text,
            'sourceGrossAmount', row.source_gross_amount,
            'currency', row.currency,
            'sourceSnapshot', row.source_snapshot
          ) order by row.commission_id
        ),
        '[]'::jsonb
      )
    )::text
  )
  from public.historical_billing_rollover_rows row
  where row.rollover_id = p_rollover_id
$$;

revoke all on function public.historical_billing_rollover_fingerprint(uuid)
  from public, anon, authenticated;
grant execute on function public.historical_billing_rollover_fingerprint(uuid)
  to service_role;

do $$
begin
  if exists (
    select 1
    from public.historical_billing_rollovers rollover
    left join lateral (
      select
        count(*)::integer as source_row_count,
        count(distinct row.ad_account_id)::integer as account_count,
        round(sum(row.billable_gross_amount), 6) as source_gross_amount
      from public.historical_billing_rollover_rows row
      where row.rollover_id = rollover.id
    ) evidence on true
    left join lateral (
      select
        count(*)::integer as account_count,
        sum(proof.source_row_count)::integer as source_row_count,
        round(sum(proof.source_gross_amount), 6) as source_gross_amount,
        sum(proof.fee_amount) as amount
      from public.historical_billing_rollover_account_proofs proof
      where proof.rollover_id = rollover.id
    ) proof on true
    left join lateral (
      select
        count(*)::integer as account_count,
        count(distinct line.value->>'accountId')::integer
          as distinct_account_count,
        count(*) filter (
          where exists (
            select 1
            from public.historical_billing_rollover_account_proofs account_proof
            where account_proof.rollover_id = rollover.id
              and account_proof.ad_account_id =
                    (line.value->>'accountId')::uuid
              and account_proof.billing_start_id =
                    (line.value->>'billingStartId')::uuid
              and account_proof.reviewed_full_day_boundary_id =
                    (line.value->>'reviewedFullDayBoundaryId')::uuid
              and account_proof.sync_run_id =
                    (line.value->>'ledgerSyncRunId')::uuid
              and account_proof.source_gross_amount =
                    (line.value->>'sourceGrossAmount')::numeric
              and account_proof.fee_amount =
                    (line.value->>'amount')::numeric
          )
        )::integer as valid_account_count,
        sum((line.value->>'amount')::numeric) as amount
      from jsonb_array_elements(rollover.line_items) line(value)
    ) lines on true
    where rollover.source_fingerprint is distinct from
          public.historical_billing_rollover_fingerprint(rollover.id)
       or rollover.source_row_count is distinct from evidence.source_row_count
       or rollover.account_count is distinct from evidence.account_count
       or rollover.source_gross_amount is distinct from evidence.source_gross_amount
       or rollover.account_count is distinct from proof.account_count
       or rollover.source_row_count is distinct from proof.source_row_count
       or rollover.source_gross_amount is distinct from proof.source_gross_amount
       or rollover.amount is distinct from proof.amount
       or rollover.account_count is distinct from lines.account_count
       or rollover.account_count is distinct from lines.distinct_account_count
       or lines.valid_account_count is distinct from lines.account_count
       or rollover.amount is distinct from lines.amount
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0035 rollover: the sealed headers and relational source proof do not match.';
  end if;

  if exists (
    select 1
    from public.historical_billing_rollover_account_proofs proof
    left join lateral (
      select
        count(*)::integer as source_row_count,
        round(sum(row.billable_gross_amount), 6) as source_gross_amount
      from public.historical_billing_rollover_rows row
      where row.rollover_id = proof.rollover_id
        and row.ad_account_id = proof.ad_account_id
        and row.billing_start_id = proof.billing_start_id
        and row.reviewed_full_day_boundary_id =
              proof.reviewed_full_day_boundary_id
        and row.sync_run_id = proof.sync_run_id
    ) rows on true
    where proof.source_row_count is distinct from rows.source_row_count
       or proof.source_gross_amount is distinct from rows.source_gross_amount
       or proof.fee_amount is distinct from
            round(proof.source_gross_amount * 0.10, 2)
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0035 rollover: an account proof does not match its exact historical commission rows.';
  end if;
end
$$;

create or replace function public.guard_historical_billing_rollover_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A historical billing rollover proof is immutable.'
    using errcode = '22023';
end
$$;

create trigger historical_billing_rollovers_guard_immutable
  before update or delete on public.historical_billing_rollovers
  for each row execute function public.guard_historical_billing_rollover_immutable();
create trigger historical_billing_rollover_account_proofs_guard_immutable
  before update or delete on public.historical_billing_rollover_account_proofs
  for each row execute function public.guard_historical_billing_rollover_immutable();
create trigger historical_billing_rollover_blockers_guard_immutable
  before update or delete on public.historical_billing_rollover_blockers
  for each row execute function public.guard_historical_billing_rollover_immutable();
create trigger historical_billing_rollover_rows_guard_immutable
  before update or delete on public.historical_billing_rollover_rows
  for each row execute function public.guard_historical_billing_rollover_immutable();
create trigger historical_billing_rollover_issuances_guard_immutable
  before update or delete on public.historical_billing_rollover_issuances
  for each row execute function public.guard_historical_billing_rollover_immutable();

alter table public.historical_billing_rollovers enable row level security;
alter table public.historical_billing_rollover_account_proofs enable row level security;
alter table public.historical_billing_rollover_blockers enable row level security;
alter table public.historical_billing_rollover_rows enable row level security;
alter table public.historical_billing_rollover_issuances enable row level security;

revoke all on
  public.historical_billing_rollovers,
  public.historical_billing_rollover_account_proofs,
  public.historical_billing_rollover_blockers,
  public.historical_billing_rollover_rows,
  public.historical_billing_rollover_issuances
from public, anon, authenticated, service_role;

grant select on
  public.historical_billing_rollovers,
  public.historical_billing_rollover_account_proofs,
  public.historical_billing_rollover_blockers,
  public.historical_billing_rollover_rows,
  public.historical_billing_rollover_issuances
to authenticated, service_role;

create policy historical_billing_rollovers_admin_service_read
  on public.historical_billing_rollovers
  for select using (public.is_admin() or auth.role() = 'service_role');
create policy historical_billing_rollover_account_proofs_admin_service_read
  on public.historical_billing_rollover_account_proofs
  for select using (public.is_admin() or auth.role() = 'service_role');
create policy historical_billing_rollover_blockers_admin_service_read
  on public.historical_billing_rollover_blockers
  for select using (public.is_admin() or auth.role() = 'service_role');
create policy historical_billing_rollover_rows_admin_service_read
  on public.historical_billing_rollover_rows
  for select using (public.is_admin() or auth.role() = 'service_role');
create policy historical_billing_rollover_issuances_admin_service_read
  on public.historical_billing_rollover_issuances
  for select using (public.is_admin() or auth.role() = 'service_role');

-- Set and validate provenance for new v3 and historical invoices.  The
-- transaction-local RPC flag separately prevents a table-owning helper from
-- inserting the special historical calculation outside its validated path.
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
    'agency-fee-eur-10-historical-rollover-2026-07-27'
  ) then
    expected_kind := case
      when new.issued_by is null then 'automation'
      else 'admin'
    end;

    if new.issuer_kind is not null
       and new.issuer_kind <> expected_kind then
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

drop trigger if exists invoices_set_policy_issuer_kind on public.invoices;
create trigger invoices_set_policy_issuer_kind
  before insert on public.invoices
  for each row execute function public.set_policy_invoice_issuer_kind();

alter table public.invoices
  drop constraint if exists invoices_issuer_provenance_check;
alter table public.invoices
  add constraint invoices_issuer_provenance_check check (
    issuer_kind is null
    or (issuer_kind = 'admin' and issued_by is not null)
    or (issuer_kind = 'automation' and issued_by is null)
  );

alter table public.invoices
  drop constraint if exists invoices_policy_issuer_required;
alter table public.invoices
  add constraint invoices_policy_issuer_required check (
    calculation_version not in (
      'agency-fee-eur-v3-manual-referrals-google-boundaries',
      'agency-fee-eur-10-historical-rollover-2026-07-27'
    )
    or issuer_kind in ('admin', 'automation')
  );

alter table public.invoices
  drop constraint if exists invoices_historical_rollover_contract;
alter table public.invoices
  add constraint invoices_historical_rollover_contract check (
    calculation_version <>
      'agency-fee-eur-10-historical-rollover-2026-07-27'
    or (
      period_start = date '2026-07-27'
      and period_end = date '2026-08-02'
      and currency = 'EUR'
      and amount > 0
      and issued_by is null
      and issuer_kind = 'automation'
      and referral_discount_term_id is null
      and public.is_valid_invoice_billing_recipient(billing_recipient)
      and jsonb_typeof(line_items) = 'array'
      and jsonb_array_length(line_items) > 0
    )
  );

-- Extend the existing immutable commercial snapshot to include provenance.
create or replace function public.guard_invoice_commercial_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An invoice commercial snapshot cannot be deleted.'
      using errcode = '22023';
  end if;

  if new.id is distinct from old.id
     or new.client_id is distinct from old.client_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.line_items is distinct from old.line_items
     or new.issued_by is distinct from old.issued_by
     or new.issuer_kind is distinct from old.issuer_kind
     or new.calculation_version is distinct from old.calculation_version
     or new.referral_discount_term_id is distinct from old.referral_discount_term_id
     or new.billing_recipient is distinct from old.billing_recipient
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

-- Automatic issue workers use the same fencing model without inventing an
-- admin UUID.  Existing lease history is known-admin because issued_by was
-- previously NOT NULL.
alter table public.billing_issue_leases
  alter column issued_by drop not null,
  add column if not exists issuer_kind text;

update public.billing_issue_leases
set issuer_kind = case
  when issued_by is null then 'automation'
  else 'admin'
end
where issuer_kind is null;

alter table public.billing_issue_leases
  alter column issuer_kind set not null;
alter table public.billing_issue_leases
  drop constraint if exists billing_issue_leases_issuer_kind_check;
alter table public.billing_issue_leases
  add constraint billing_issue_leases_issuer_kind_check check (
    (issuer_kind = 'admin' and issued_by is not null)
    or (issuer_kind = 'automation' and issued_by is null)
  );

comment on column public.billing_issue_leases.issuer_kind is
  'admin when issued_by is a verified admin; automation when the service worker intentionally supplies NULL.';

create or replace function public.acquire_billing_issue_lease(
  p_client_id uuid,
  p_lease_token uuid,
  p_period_start date,
  p_issued_by uuid
)
returns setof public.billing_issue_leases
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_lifetime constant interval := interval '5 minutes';
  current_lease public.billing_issue_leases%rowtype;
  previous_lease public.billing_issue_leases%rowtype;
  acquired_lease public.billing_issue_leases%rowtype;
  next_fence bigint;
  requested_issuer_kind text;
  v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can acquire an issue lease.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or p_lease_token is null
     or p_period_start is null
     or extract(isodow from p_period_start) <> 1 then
    raise exception 'A client, unique lease token and Monday period are required.'
      using errcode = '22023';
  end if;

  requested_issuer_kind := case
    when p_issued_by is null then 'automation'
    else 'admin'
  end;

  if p_issued_by is not null and not exists (
    select 1
    from public.profiles profile
    where profile.id = p_issued_by
      and profile.role = 'admin'
  ) then
    raise exception 'A non-null billing lease issuer must be a verified admin.'
      using errcode = '42501';
  end if;

  perform 1
  from public.portal_clients client
  where client.id = p_client_id
    and (
      requested_issuer_kind = 'admin'
      or (
        client.approval_status in ('approved', 'rejected')
        and not exists (
          select 1
          from public.profiles profile
          where profile.id = client.id and profile.role = 'admin'
        )
      )
    )
  for update;
  if not found then
    raise exception 'The billing client does not exist or is not eligible for automatic issue.'
      using errcode = '22023';
  end if;

  v_now := clock_timestamp();

  select * into current_lease
  from public.billing_issue_leases lease
  where lease.lease_token = p_lease_token;

  if found then
    if current_lease.client_id <> p_client_id
       or current_lease.period_start <> p_period_start
       or current_lease.issued_by is distinct from p_issued_by
       or current_lease.issuer_kind <> requested_issuer_kind then
      raise exception 'A billing lease token cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    select * into previous_lease
    from public.billing_issue_leases lease
    where lease.client_id = p_client_id
    order by lease.fencing_token desc
    limit 1;

    if previous_lease.lease_token <> p_lease_token
       or current_lease.released_at is not null
       or current_lease.lease_expires_at <= v_now then
      raise exception 'A completed or expired billing lease token cannot be reused.'
        using errcode = '22023';
    end if;

    update public.billing_issue_leases lease
    set renewed_at = v_now,
        lease_expires_at = v_now + lease_lifetime
    where lease.lease_token = p_lease_token
    returning * into acquired_lease;

    return next acquired_lease;
    return;
  end if;

  select * into previous_lease
  from public.billing_issue_leases lease
  where lease.client_id = p_client_id
  order by lease.fencing_token desc
  limit 1;

  if found
     and previous_lease.released_at is null
     and previous_lease.lease_expires_at > v_now then
    return;
  end if;

  next_fence := coalesce(previous_lease.fencing_token, 0) + 1;
  insert into public.billing_issue_leases (
    lease_token,
    client_id,
    fencing_token,
    period_start,
    issued_by,
    issuer_kind,
    acquired_at,
    renewed_at,
    lease_expires_at
  ) values (
    p_lease_token,
    p_client_id,
    next_fence,
    p_period_start,
    p_issued_by,
    requested_issuer_kind,
    v_now,
    v_now,
    v_now + lease_lifetime
  ) returning * into acquired_lease;

  return next acquired_lease;
end
$$;

revoke all on function public.acquire_billing_issue_lease(
  uuid, uuid, date, uuid
) from public, anon, authenticated;
grant execute on function public.acquire_billing_issue_lease(
  uuid, uuid, date, uuid
) to service_role;

-- `create_manual_referral_invoice` is a large, already-audited exact
-- calculator.  Its only human-only assumption is the guard below.  Patch that
-- one catalog-preserved source fragment rather than fork hundreds of lines of
-- pricing SQL: abort unless the deployed body contains exactly one audited
-- fragment, then retain every other byte of its function body.  The caller is
-- still service_role-only; NULL now means the global automation policy, while
-- every non-null UUID remains subject to the existing admin-profile check.
do $migration$
declare
  function_signature constant regprocedure :=
    'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure;
  function_definition text;
  old_fragment constant text := $old$
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
$old$;
  new_fragment constant text := $new$
  if p_issued_by is not null and not exists (
    select 1 from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
$new$;
  occurrence_count integer;
begin
  select pg_get_functiondef(function_signature)
    into function_definition;

  occurrence_count := (
    length(function_definition)
      - length(replace(function_definition, old_fragment, ''))
  ) / length(old_fragment);

  if occurrence_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = '0035 rollover: create_manual_referral_invoice no longer matches the audited admin-issuer guard.';
  end if;

  execute replace(function_definition, old_fragment, new_fragment);
end
$migration$;

comment on function public.create_manual_referral_invoice(
  uuid, date, date, numeric, jsonb, jsonb, jsonb, uuid, uuid, text
) is
  'Service-only v3 invoice snapshot RPC. p_issued_by NULL records global automation; a non-null issuer must remain a verified admin.';

create or replace function public.create_historical_rollover_invoice(
  p_rollover_id uuid
)
returns setof public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  rollover public.historical_billing_rollovers%rowtype;
  existing_issuance public.historical_billing_rollover_issuances%rowtype;
  created_invoice public.invoices%rowtype;
  expected_billing_recipient jsonb;
  claimed_rows integer;
  business_day date := (clock_timestamp() at time zone 'Europe/Lisbon')::date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing automation service can create a historical rollover invoice.'
      using errcode = '42501';
  end if;

  if p_rollover_id is null then
    raise exception 'A sealed historical rollover id is required.'
      using errcode = '22023';
  end if;

  -- A completed marker is only proof while it still equals the locked ledger.
  -- Serialize this one-time historical issue with the same mutable sources the
  -- migration certified; reviewed starts/boundaries themselves are immutable.
  lock table public.commissions in share row exclusive mode;
  lock table public.revenue_sources in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.google_ledger_sync_windows in share row exclusive mode;

  select * into rollover
  from public.historical_billing_rollovers header
  where header.id = p_rollover_id
  for update;

  if not found then
    raise exception 'The sealed historical rollover does not exist.'
      using errcode = '22023';
  end if;

  -- A retry is a read of the immutable receipt, not a second invoice attempt.
  select * into existing_issuance
  from public.historical_billing_rollover_issuances issuance
  where issuance.rollover_id = rollover.id;

  if found then
    select * into created_invoice
    from public.invoices invoice
    where invoice.id = existing_issuance.invoice_id;

    if not found
       or created_invoice.client_id <> rollover.client_id
       or created_invoice.period_start <> rollover.period_start
       or created_invoice.calculation_version <> rollover.calculation_version then
      raise exception 'The historical rollover receipt no longer matches its invoice.'
        using errcode = 'P0001';
    end if;

    return next created_invoice;
    return;
  end if;

  if rollover.period_start <> date '2026-07-27'
     or rollover.period_end <> date '2026-08-02'
     or rollover.currency <> 'EUR'
     or rollover.fee_rate <> 10::numeric
     or rollover.ad_spend_pass_through_rate <> 0::numeric
     or rollover.revenue_share_rate <> 0::numeric
     or rollover.referral_discount_rate <> 0::numeric
     or rollover.amount <= 0
     or rollover.source_fingerprint is distinct from
        public.historical_billing_rollover_fingerprint(rollover.id) then
    raise exception 'The historical rollover policy or source proof is invalid.'
      using errcode = 'P0001';
  end if;

  if rollover.source_row_count <> (
       select count(*)
       from public.historical_billing_rollover_rows row
       where row.rollover_id = rollover.id
     )
     or rollover.account_count <> (
       select count(distinct row.ad_account_id)
       from public.historical_billing_rollover_rows row
       where row.rollover_id = rollover.id
     )
     or rollover.source_gross_amount <> (
       select round(sum(row.billable_gross_amount), 6)
       from public.historical_billing_rollover_rows row
       where row.rollover_id = rollover.id
     ) then
    raise exception 'The historical rollover header no longer matches its source rows.'
      using errcode = 'P0001';
  end if;

  if rollover.account_count <> (
       select count(*)
       from public.historical_billing_rollover_account_proofs proof
       where proof.rollover_id = rollover.id
     )
     or rollover.source_row_count <> (
       select sum(proof.source_row_count)
       from public.historical_billing_rollover_account_proofs proof
       where proof.rollover_id = rollover.id
     )
     or rollover.source_gross_amount <> (
       select round(sum(proof.source_gross_amount), 6)
       from public.historical_billing_rollover_account_proofs proof
       where proof.rollover_id = rollover.id
     )
     or rollover.amount <> (
       select sum(proof.fee_amount)
       from public.historical_billing_rollover_account_proofs proof
       where proof.rollover_id = rollover.id
     )
     or exists (
       select 1
       from public.historical_billing_rollover_account_proofs proof
       where proof.rollover_id = rollover.id
         and proof.fee_amount <>
               round(proof.source_gross_amount * 0.10, 2)
     ) then
    raise exception 'The historical rollover header no longer matches its account proofs.'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.historical_billing_rollover_account_proofs proof
    left join public.ad_account_billing_starts billing_start
      on billing_start.id = proof.billing_start_id
     and billing_start.ad_account_id = proof.ad_account_id
     and billing_start.reviewed_full_day_boundary_id =
           proof.reviewed_full_day_boundary_id
     and billing_start.google_ads_customer_id =
           proof.google_ads_customer_id
     and billing_start.google_local_date = proof.google_local_date
     and billing_start.google_time_zone = proof.google_time_zone
     and billing_start.currency = proof.currency
    left join public.reviewed_full_day_billing_boundaries boundary
      on boundary.id = proof.reviewed_full_day_boundary_id
     and boundary.ad_account_id = proof.ad_account_id
     and boundary.google_ads_customer_id = proof.google_ads_customer_id
     and boundary.google_local_date = proof.google_local_date
     and boundary.google_time_zone = proof.google_time_zone
     and boundary.currency = proof.currency
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = proof.ad_account_id
     and billing_end.billing_start_id = proof.billing_start_id
     and billing_end.google_ads_customer_id = proof.google_ads_customer_id
     and billing_end.google_time_zone = proof.google_time_zone
     and billing_end.currency = proof.currency
    left join public.google_ledger_sync_windows sync
      on sync.ad_account_id = proof.ad_account_id
     and sync.period_start = proof.period_start
     and sync.period_end = proof.period_end
     and sync.run_id = proof.sync_run_id
    where proof.rollover_id = rollover.id
      and (
        billing_start.id is null
        or billing_start.start_basis <> 'reviewed_full_day'
        or billing_start.baseline_cost_micros is not null
        or billing_start.captured_at is not null
        or boundary.id is null
        or boundary.metadata_capture_id <> proof.metadata_capture_id
        or boundary.source_fingerprint <>
             proof.boundary_source_fingerprint
        or boundary.source_fingerprint <> md5(
          jsonb_build_object(
            'policyVersion', boundary.policy_version,
            'cutoverMonday', boundary.cutover_monday::text,
            'entryDayTreatment', boundary.entry_day_treatment,
            'sourceSnapshot', boundary.source_snapshot
          )::text
        )
        or sync.ad_account_id is null
        or sync.billing_start_id <> proof.billing_start_id
        or sync.status <> 'complete'
        or billing_end.google_local_date between
             proof.period_start and proof.period_end
        or not (
          sync.billing_end_id is not distinct from billing_end.id
          or (
            billing_end.google_local_date > proof.period_end
            and sync.billing_end_id is null
          )
        )
        or sync.started_at <> proof.sync_started_at
        or sync.synced_at <> proof.sync_synced_at
        or sync.ledger_snapshot <> proof.sync_ledger_snapshot
        or (sync.synced_at at time zone proof.google_time_zone)::date
             <= proof.period_end
        or proof.sync_ledger_snapshot is distinct from (
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
              )
              order by commission.id
            ),
            '[]'::jsonb
          )
          from public.commissions commission
          join public.revenue_sources source
            on source.id = commission.source_id
          where commission.ad_account_id = proof.ad_account_id
            and source.name = 'Google Ads Management'
            and commission.status = 'confirmed'
            and commission.occurred_on between
              greatest(proof.period_start, proof.google_local_date)
              and proof.period_end
        )
      )
  ) then
    raise exception 'A historical rollover account no longer has its exact reviewed Google proof.'
      using errcode = 'P0001';
  end if;

  if cardinality(rollover.legacy_invoice_ids) < 1 then
    raise exception 'A historical rollover must replace at least one preserved legacy void.'
      using errcode = 'P0001';
  end if;

  -- The legacy void remains in place.  Any other invoice occupies the one
  -- reviewed replacement slot and is never overwritten or silently reused.
  if exists (
    select 1
    from public.invoices invoice
    where invoice.client_id = rollover.client_id
      and invoice.period_start = rollover.period_start
      and invoice.calculation_version <> 'legacy'
  ) then
    raise exception 'A non-legacy invoice already occupies this client week.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from unnest(rollover.legacy_invoice_ids) legacy_invoice_id
    left join public.invoices invoice on invoice.id = legacy_invoice_id
    where invoice.id is null
       or invoice.client_id <> rollover.client_id
       or invoice.period_start <> rollover.period_start
       or invoice.period_end <> rollover.period_end
       or invoice.calculation_version <> 'legacy'
       or invoice.status <> 'void'
       or invoice.issued_at is not null
       or invoice.stripe_invoice_id is not null
       or invoice.paid_at is not null
       or invoice.stripe_sent_at is not null
       or invoice.stripe_delivery_assumed_at is not null
  ) then
    raise exception 'The preserved legacy void is no longer safe to replace.'
      using errcode = 'P0001';
  end if;

  -- Serialize recipient identity with creation and derive it server-side.  The
  -- cron never supplies editable commercial JSON.
  lock table public.portal_clients in share row exclusive mode;
  lock table public.profiles in share row exclusive mode;
  lock table public.billing_profiles in share row exclusive mode;

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
  where client.id = rollover.client_id
    and client.approval_status in ('approved', 'rejected')
    and not exists (
      select 1
      from public.profiles profile
      where profile.id = client.id and profile.role = 'admin'
    );

  if expected_billing_recipient is null
     or not public.is_valid_invoice_billing_recipient(
       expected_billing_recipient
     ) then
    raise exception 'The automated historical invoice client is ineligible or its recipient is invalid or incomplete.'
      using errcode = '22023';
  end if;

  perform set_config(
    'dropscale.historical_rollover_invoice_rpc',
    'on',
    true
  );

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
    issuer_kind,
    issue_attempted_at,
    calculation_version,
    referral_discount_term_id,
    billing_recipient
  ) values (
    rollover.client_id,
    rollover.period_start,
    rollover.period_end,
    rollover.amount,
    'EUR',
    'draft',
    business_day + 7,
    rollover.line_items,
    null,
    null,
    null,
    'automation',
    null,
    rollover.calculation_version,
    null,
    expected_billing_recipient
  ) returning * into created_invoice;

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
    row.commission_id,
    row.source_gross_amount,
    row.billing_start_id,
    0,
    null,
    null,
    row.billable_gross_amount,
    'EUR'
  from public.historical_billing_rollover_rows row
  where row.rollover_id = rollover.id
  order by row.commission_id;

  get diagnostics claimed_rows = row_count;
  if claimed_rows <> rollover.source_row_count then
    raise exception 'Every sealed historical source row must be consumed exactly once.'
      using errcode = 'P0001';
  end if;

  insert into public.historical_billing_rollover_issuances (
    rollover_id,
    invoice_id,
    issuer_kind,
    calculation_version,
    billing_recipient
  ) values (
    rollover.id,
    created_invoice.id,
    'automation',
    rollover.calculation_version,
    expected_billing_recipient
  );

  return next created_invoice;
end
$$;

revoke all on function public.create_historical_rollover_invoice(uuid)
  from public, anon, authenticated;
grant execute on function public.create_historical_rollover_invoice(uuid)
  to service_role;

comment on function public.create_historical_rollover_invoice(uuid) is
  'Service-only idempotent creation of one local automation draft from the sealed 2026-07-27 historical policy. It performs no Stripe operation.';

create view public.historical_billing_rollover_review
with (security_invoker = true)
as
select
  rollover.id as rollover_id,
  rollover.client_id,
  rollover.period_start,
  rollover.period_end,
  rollover.amount,
  rollover.currency,
  rollover.calculation_version,
  rollover.fee_rate,
  rollover.ad_spend_pass_through_rate,
  rollover.revenue_share_rate,
  rollover.referral_discount_rate,
  rollover.source_gross_amount,
  rollover.source_row_count,
  rollover.account_count,
  rollover.line_items,
  rollover.legacy_invoice_ids,
  rollover.source_fingerprint,
  rollover.snapshot_created_at,
  rollover.snapshot_created_by,
  issuance.invoice_id,
  invoice.status as invoice_status,
  invoice.issued_at as invoice_issued_at,
  invoice.issue_error as invoice_issue_error,
  invoice.issuer_kind,
  invoice.created_at as invoice_created_at
from public.historical_billing_rollovers rollover
left join public.historical_billing_rollover_issuances issuance
  on issuance.rollover_id = rollover.id
left join public.invoices invoice
  on invoice.id = issuance.invoice_id;

revoke all on public.historical_billing_rollover_review
  from public, anon, authenticated, service_role;
grant select on public.historical_billing_rollover_review
  to authenticated, service_role;

comment on view public.historical_billing_rollover_review is
  'Admin/service read model joining each sealed historical rollover to its eventual local invoice receipt and state.';

notify pgrst, 'reload schema';
