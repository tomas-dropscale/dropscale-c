-- Live-schema snapshot for the PGlite harness: the pieces of migrations
-- 0034/0035 that the CURRENT create_manual_referral_invoice (carried by 0037)
-- depends on, taken from the production database. Test-only; never applied to
-- a real environment.

alter table public.ad_account_billing_starts
  add column if not exists start_basis text not null default 'observed_google_counter';
alter table public.ad_account_billing_starts
  add column if not exists reviewed_full_day_boundary_id uuid;
alter table public.ad_account_billing_starts
  alter column baseline_cost_micros drop not null;

create table if not exists public.reviewed_full_day_billing_boundaries (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null,
  client_id uuid not null,
  google_ads_customer_id text not null,
  account_created_at timestamptz not null,
  entry_day date not null,
  entry_time_zone text not null,
  google_local_date date not null,
  google_time_zone text not null,
  entry_day_treatment text not null,
  currency text not null,
  cutover_monday date not null,
  policy_version text not null,
  metadata_capture_id uuid not null,
  metadata_capture_started_at timestamptz not null,
  metadata_captured_at timestamptz not null,
  metadata_authority text not null,
  metadata_contract text not null,
  source_snapshot jsonb not null,
  source_fingerprint text not null,
  sealed_at timestamptz not null default clock_timestamp(),
  sealed_by text not null default current_user
);

CREATE OR REPLACE FUNCTION public.manual_invoice_authoritative_rows(p_client_id uuid, p_period_start date, p_period_end date)
 RETURNS TABLE(commission_id uuid, account_id uuid, store_name text, occurred_on date, currency text, billing_start_id uuid, billing_start_date date, billing_started_at timestamp with time zone, billing_time_zone text, billing_start_baseline_micros numeric, opening_baseline_applied boolean, billing_end_id uuid, billing_end_date date, billing_ended_at timestamp with time zone, billing_end_time_zone text, billing_end_counter_micros numeric, ending_cap_applied boolean, source_gross_micros numeric, baseline_deduction_micros numeric, end_deduction_micros numeric, billable_gross_micros numeric, source_gross_amount numeric, baseline_deduction_amount numeric, end_deduction_amount numeric, billable_gross_amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
