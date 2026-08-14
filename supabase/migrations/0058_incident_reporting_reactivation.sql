-- =============================================================================
-- 0058 - One-shot repair for the accidental Phase 2 reporting rollback.
--
-- This is deliberately not a generic lifecycle transition. It accepts only
-- the purpose-bound rollback emitted by the Phase 2 endpoint during the last
-- hour, repeats the complete reporting authority gate, preserves every marker,
-- binding, fact and financial row, then appends an immutable linked audit row.
-- =============================================================================

alter table public.client_onboarding_events
  drop constraint if exists client_onboarding_events_event_type_check;
alter table public.client_onboarding_events
  add constraint client_onboarding_events_event_type_check check (event_type in (
    'invitation_created', 'invitation_rotated', 'identity_claimed',
    'shopify_connected', 'google_connected', 'assets_mapped',
    'submitted', 'reviewed', 'activated', 'reporting_rollback',
    'reporting_reactivation', 'invitation_revoked', 'connections_revoked',
    'verification_succeeded', 'verification_failed'
  ));

create unique index client_onboarding_events_reporting_reactivation_session_uq
  on public.client_onboarding_events(session_id)
  where event_type = 'reporting_reactivation';

create or replace function public.guard_client_reporting_cutover_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purpose_bound_marker_write boolean := false;
  purpose_bound_rollback boolean := false;
  purpose_bound_reactivation boolean := false;
begin
  if tg_op = 'DELETE' then
    if old.reporting_cutover_at is not null then
      raise exception 'A reporting cutover marker is durable and cannot be deleted.'
        using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.reporting_cutover_at is not null then
      raise exception 'Only the reporting cutover RPC may set its marker.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  purpose_bound_marker_write :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.reporting_cutover_marker', true)
          is not distinct from new.client_id::text;
  purpose_bound_rollback :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.reporting_cutover_rollback', true)
          is not distinct from new.client_id::text;
  purpose_bound_reactivation :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.reporting_cutover_reactivation', true)
          is not distinct from new.client_id::text;

  if new.reporting_cutover_at is distinct from old.reporting_cutover_at
    or new.reporting_cutover_by is distinct from old.reporting_cutover_by
    or new.reporting_cutover_reason is distinct from old.reporting_cutover_reason
  then
    if old.reporting_cutover_at is not null
      or not purpose_bound_marker_write
      or new.client_id is distinct from old.client_id
      or new.operational_surface <> 'v2_active'
      or new.reporting_cutover_at is null
      or new.reporting_cutover_by is null
      or new.reporting_cutover_reason is null
      or new.updated_by is distinct from new.reporting_cutover_by
      or new.reporting_cutover_at < clock_timestamp() - interval '1 minute'
      or new.reporting_cutover_at > clock_timestamp() + interval '1 minute'
    then
      raise exception 'A reporting cutover marker is immutable and purpose-bound.'
        using errcode = '23514';
    end if;
  end if;

  if old.reporting_cutover_at is not null
    and old.operational_surface <> 'v2_active'
    and new.operational_surface = 'v2_active'
    and not purpose_bound_reactivation
  then
    raise exception 'A rolled-back reporting cutover cannot be reactivated generically.'
      using errcode = '23514';
  end if;

  if old.reporting_cutover_at is not null
    and new.operational_surface is distinct from old.operational_surface
  then
    if not (
      (
        old.operational_surface = 'v2_active'
        and new.operational_surface = 'rollback_legacy'
        and purpose_bound_rollback
      )
      or (
        old.operational_surface = 'rollback_legacy'
        and new.operational_surface = 'v2_active'
        and purpose_bound_reactivation
      )
    )
      or new.onboarding_session_id is distinct from old.onboarding_session_id
      or new.updated_by is null
      or not exists (
        select 1 from public.profiles profile
        where profile.id = new.updated_by and profile.role = 'admin'
      )
      or new.updated_at < clock_timestamp() - interval '1 minute'
      or new.updated_at > clock_timestamp() + interval '1 minute'
    then
      raise exception 'A marker-active reporting surface may only transition through its purpose-bound RPC.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

create or replace function public.guard_client_reporting_cutover_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_is_reporting boolean := false;
  new_is_reporting boolean := false;
  event_client_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_is_reporting := (
      old.event_type = 'activated'
      and old.details ->> 'reportingBindings' = 'true'
    ) or old.event_type in ('reporting_rollback', 'reporting_reactivation');
  end if;
  if tg_op <> 'DELETE' then
    new_is_reporting := (
      new.event_type = 'activated'
      and new.details ->> 'reportingBindings' = 'true'
    ) or new.event_type in ('reporting_rollback', 'reporting_reactivation');
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old_is_reporting then
    raise exception 'A reporting cutover audit event is immutable.'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new_is_reporting then
    raise exception 'A reporting cutover audit event cannot be manufactured by update.'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new_is_reporting then
    select session.claimed_user_id into event_client_id
    from public.client_onboarding_sessions session
    where session.id = new.session_id;

    if new.event_type = 'reporting_reactivation' then
      if event_client_id is null
        or auth.role() is distinct from 'service_role'
        or new.actor_type <> 'admin'
        or new.actor_id is null
        or current_setting('dropscale.reporting_cutover_reactivation', true)
             is distinct from event_client_id::text
        or (select count(*) from jsonb_object_keys(new.details)) <> 8
        or not (new.details ?& array[
          'reason', 'reportingCutoverAt', 'reportingCutoverReason',
          'reportingActivationEventId', 'reportingRollbackEventId',
          'reportingRollbackAt', 'reportingRollbackReason',
          'reportingReactivationAt'
        ])
        or new.details ->> 'reason' is distinct from
             'Repair accidental Phase 2 rollback after secret propagation check'
        or not exists (
          select 1
          from public.client_rollout_states rollout
          join public.profiles actor
            on actor.id = new.actor_id and actor.role = 'admin'
          join public.client_onboarding_events activation
            on activation.id::text = new.details ->> 'reportingActivationEventId'
           and activation.session_id = new.session_id
           and activation.event_type = 'activated'
           and activation.actor_type = 'admin'
           and activation.actor_id = rollout.reporting_cutover_by
           and activation.details ->> 'reportingBindings' = 'true'
           and activation.details ->> 'reason' = rollout.reporting_cutover_reason
           and activation.details ->> 'reportingCutoverAt'
                 = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
          join public.client_onboarding_events rollback
            on rollback.id::text = new.details ->> 'reportingRollbackEventId'
           and rollback.session_id = new.session_id
           and rollback.event_type = 'reporting_rollback'
           and rollback.actor_type = 'admin'
           and rollback.details ->> 'reason'
                 = 'Emergency purpose-bound Phase 2 reporting rollback'
           and rollback.details ->> 'reportingCutoverAt'
                 = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
           and rollback.details ->> 'reportingCutoverReason'
                 = rollout.reporting_cutover_reason
           and rollback.details ->> 'reportingRollbackAt'
                 = new.details ->> 'reportingRollbackAt'
          where rollout.client_id = event_client_id
            and rollout.operational_surface = 'v2_active'
            and rollout.reporting_cutover_at is not null
            and rollout.reporting_cutover_by is not null
            and rollout.reporting_cutover_reason is not null
            and rollout.updated_by = new.actor_id
            and new.details ->> 'reportingCutoverAt'
                  = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
            and new.details ->> 'reportingCutoverReason'
                  = rollout.reporting_cutover_reason
            and new.details ->> 'reportingRollbackReason'
                  = rollback.details ->> 'reason'
            and new.details ->> 'reportingReactivationAt'
                  = (to_jsonb(rollout.updated_at) #>> '{}')
            and (rollback.details ->> 'reportingRollbackAt')::timestamptz
                  >= clock_timestamp() - interval '1 hour'
            and (rollback.details ->> 'reportingRollbackAt')::timestamptz
                  <= clock_timestamp() + interval '1 minute'
        )
      then
        raise exception 'A reporting reactivation event must match its one-shot incident repair.'
          using errcode = '23514';
      end if;
    elsif new.event_type = 'reporting_rollback' then
      if event_client_id is null
        or auth.role() is distinct from 'service_role'
        or new.actor_type <> 'admin'
        or new.actor_id is null
        or current_setting('dropscale.reporting_cutover_rollback', true)
             is distinct from event_client_id::text
        or (select count(*) from jsonb_object_keys(new.details)) <> 4
        or not (new.details ?& array[
          'reason', 'reportingCutoverAt',
          'reportingCutoverReason', 'reportingRollbackAt'
        ])
        or new.details ->> 'reason' is distinct from
             btrim(new.details ->> 'reason')
        or length(new.details ->> 'reason') not between 3 and 500
        or not exists (
          select 1
          from public.client_rollout_states rollout
          join public.profiles actor
            on actor.id = new.actor_id and actor.role = 'admin'
          where rollout.client_id = event_client_id
            and rollout.operational_surface = 'rollback_legacy'
            and rollout.reporting_cutover_at is not null
            and rollout.reporting_cutover_by is not null
            and rollout.reporting_cutover_reason is not null
            and rollout.updated_by = new.actor_id
            and new.details ->> 'reportingCutoverAt'
                  = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
            and new.details ->> 'reportingCutoverReason'
                  = rollout.reporting_cutover_reason
            and new.details ->> 'reportingRollbackAt'
                  = (to_jsonb(rollout.updated_at) #>> '{}')
            and exists (
              select 1
              from public.client_onboarding_events activation
              where activation.session_id = new.session_id
                and activation.event_type = 'activated'
                and activation.actor_type = 'admin'
                and activation.actor_id = rollout.reporting_cutover_by
                and activation.details ->> 'reportingBindings' = 'true'
                and activation.details ->> 'reason'
                      = rollout.reporting_cutover_reason
                and activation.details ->> 'reportingCutoverAt'
                      = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
            )
        )
      then
        raise exception 'A reporting rollback event must match its purpose-bound transition.'
          using errcode = '23514';
      end if;
    elsif event_client_id is null
      or auth.role() is distinct from 'service_role'
      or current_setting('dropscale.reporting_cutover_marker', true)
           is distinct from event_client_id::text
      or not exists (
        select 1 from public.client_rollout_states rollout
        where rollout.client_id = event_client_id
          and rollout.operational_surface = 'v2_active'
          and rollout.reporting_cutover_at is not null
          and rollout.reporting_cutover_by = new.actor_id
          and rollout.reporting_cutover_reason = new.details ->> 'reason'
          and new.details ->> 'reportingCutoverAt'
                = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
      )
    then
      raise exception 'A reporting cutover event must match its purpose-bound marker.'
        using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create or replace function public.reactivate_client_reporting_cutover(
  p_client_id uuid,
  p_admin_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rollout public.client_rollout_states%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
  source_count integer;
  binding_count integer;
  activation_event_count integer;
  activation_event_id uuid;
  cutover_session_id uuid;
  rollback_event_count integer;
  rollback_event_id uuid;
  rollback_actor_id uuid;
  rollback_reason text;
  rollback_time_text text;
  rollback_time timestamptz;
  rollback_created_at timestamptz;
  reactivation_event_count integer;
  reactivation_time timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can repair the incident rollback.'
      using errcode = '42501';
  end if;
  if p_client_id is null
    or not exists (
      select 1 from public.profiles where id = p_admin_id and role = 'admin'
    )
    or normal_reason is distinct from
       'Repair accidental Phase 2 rollback after secret propagation check'
  then
    raise exception 'Invalid incident reporting reactivation request.'
      using errcode = '22023';
  end if;

  lock table
    public.client_shopify_connections,
    public.client_shopify_credentials,
    public.client_google_ads_connections,
    public.client_asset_mappings,
    public.client_reporting_bindings,
    public.client_reporting_sync_states,
    public.daily_metrics
  in share row exclusive mode;

  perform client.id
  from public.portal_clients client
  join public.profiles profile on profile.id = client.id
  where client.id = p_client_id
    and client.approval_status = 'approved'
    and profile.role <> 'admin'
  for share of client, profile;
  if not found then
    raise exception 'Only an approved non-admin client can repair reporting authority.'
      using errcode = '23514';
  end if;

  select * into rollout
  from public.client_rollout_states state
  where state.client_id = p_client_id
  for update;
  if not found
    or rollout.reporting_cutover_at is null
    or rollout.reporting_cutover_by is null
    or rollout.reporting_cutover_reason is null
  then
    raise exception 'A complete reporting cutover marker is required.'
      using errcode = '23514';
  end if;

  select count(*)::integer,
         min(event.id::text)::uuid,
         min(event.session_id::text)::uuid
    into activation_event_count, activation_event_id, cutover_session_id
  from public.client_onboarding_events event
  join public.client_onboarding_sessions session on session.id = event.session_id
  where session.claimed_user_id = p_client_id
    and event.event_type = 'activated'
    and event.actor_type = 'admin'
    and event.actor_id = rollout.reporting_cutover_by
    and event.details ->> 'reportingBindings' = 'true'
    and event.details ->> 'reason' = rollout.reporting_cutover_reason
    and event.details ->> 'reportingCutoverAt'
          = (to_jsonb(rollout.reporting_cutover_at) #>> '{}');
  if activation_event_count <> 1
    or activation_event_id is null
    or cutover_session_id is null
  then
    raise exception 'Incident repair requires exactly one matching activation audit event.'
      using errcode = '23514';
  end if;

  select count(*)::integer, min(event.id::text)::uuid
    into rollback_event_count, rollback_event_id
  from public.client_onboarding_events event
  where event.session_id = cutover_session_id
    and event.event_type = 'reporting_rollback';
  if rollback_event_count <> 1 or rollback_event_id is null then
    raise exception 'Incident repair requires exactly one matching rollback audit event.'
      using errcode = '23514';
  end if;

  select event.actor_id, event.details ->> 'reason',
         event.details ->> 'reportingRollbackAt', event.created_at
    into rollback_actor_id, rollback_reason, rollback_time_text, rollback_created_at
  from public.client_onboarding_events event
  where event.id = rollback_event_id
    and event.session_id = cutover_session_id
    and event.event_type = 'reporting_rollback'
    and event.actor_type = 'admin'
    and event.details ->> 'reportingCutoverAt'
          = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
    and event.details ->> 'reportingCutoverReason'
          = rollout.reporting_cutover_reason;
  if not found
    or rollback_actor_id is null
    or not exists (
      select 1 from public.profiles where id = rollback_actor_id and role = 'admin'
    )
    or rollback_reason is distinct from
       'Emergency purpose-bound Phase 2 reporting rollback'
    or rollback_time_text is null
  then
    raise exception 'The rollback audit does not match the Phase 2 incident.'
      using errcode = '23514';
  end if;
  begin
    rollback_time := rollback_time_text::timestamptz;
  exception when others then
    raise exception 'The rollback audit has an invalid incident timestamp.'
      using errcode = '23514';
  end;
  select count(*)::integer into reactivation_event_count
  from public.client_onboarding_events event
  where event.session_id = cutover_session_id
    and event.event_type = 'reporting_reactivation';

  if rollout.operational_surface = 'v2_active' then
    if reactivation_event_count = 1
      and rollout.updated_by = p_admin_id
      and exists (
        select 1
        from public.client_onboarding_events event
        where event.session_id = cutover_session_id
          and event.event_type = 'reporting_reactivation'
          and event.actor_type = 'admin'
          and event.actor_id = p_admin_id
          and event.details ->> 'reason' = normal_reason
          and event.details ->> 'reportingActivationEventId' = activation_event_id::text
          and event.details ->> 'reportingRollbackEventId' = rollback_event_id::text
          and event.details ->> 'reportingCutoverAt'
                = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
          and event.details ->> 'reportingCutoverReason'
                = rollout.reporting_cutover_reason
          and event.details ->> 'reportingRollbackAt' = rollback_time_text
          and event.details ->> 'reportingRollbackReason' = rollback_reason
          and event.details ->> 'reportingReactivationAt'
                = (to_jsonb(rollout.updated_at) #>> '{}')
      )
    then
      return p_client_id;
    end if;
    raise exception 'Reporting reactivation is already recorded with different authority or reason.'
      using errcode = '23514';
  end if;
  if rollback_time < clock_timestamp() - interval '1 hour'
    or rollback_time > clock_timestamp() + interval '1 minute'
    or rollback_created_at < rollback_time - interval '1 minute'
    or rollback_created_at > rollback_time + interval '1 minute'
  then
    raise exception 'The Phase 2 incident rollback is outside the one-hour repair window.'
      using errcode = '23514';
  end if;
  if rollout.operational_surface <> 'rollback_legacy'
    or reactivation_event_count <> 0
    or rollout.updated_by is distinct from rollback_actor_id
    or (to_jsonb(rollout.updated_at) #>> '{}') is distinct from rollback_time_text
  then
    raise exception 'Only the exact unrepaired Phase 2 rollback can be reactivated.'
      using errcode = '23514';
  end if;

  perform connection.id
  from public.client_shopify_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform credential.connection_id
  from public.client_shopify_credentials credential
  join public.client_shopify_connections connection
    on connection.id = credential.connection_id
  where connection.client_id = p_client_id and connection.status = 'connected'
  for share of credential;
  perform connection.id
  from public.client_google_ads_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform binding.id
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active'
  for share;
  -- Billing-end commits serialize on the account row before inserting their
  -- immutable boundary. Holding the same row through the open-boundary check
  -- closes status, identity and end-insert races without a finance-table
  -- lock-order inversion.
  perform account.id
  from public.ad_accounts account
  join public.client_reporting_bindings binding
    on binding.ad_account_id = account.id
  where binding.client_id = p_client_id and binding.status = 'active'
  for share of account;
  perform receipt.binding_id
  from public.client_reporting_sync_states receipt
  join public.client_reporting_bindings binding on binding.id = receipt.binding_id
  where binding.client_id = p_client_id and binding.status = 'active'
  for share of receipt;

  select
    (select count(*) from public.client_shopify_connections source
      where source.client_id = p_client_id and source.status = 'connected')
    +
    (select count(*) from public.client_google_ads_connections source
      where source.client_id = p_client_id and source.status = 'connected')
  into source_count;
  if source_count = 0 then
    raise exception 'Incident repair requires at least one connected source.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
  ) then
    raise exception 'Incident repair requires at least one active Shopify anchor.'
      using errcode = '23514';
  end if;

  select count(binding.shopify_connection_id)
       + count(binding.google_ads_connection_id)
    into binding_count
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active';
  if binding_count <> source_count
    or exists (
      select 1
      from public.client_shopify_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or not exists (
            select 1 from public.client_shopify_credentials credential
            where credential.connection_id = source.id
          )
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.shopify_connection_id = source.id
          )
        )
    )
    or exists (
      select 1
      from public.client_google_ads_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or source.currency is null
          or source.currency !~ '^[A-Z]{3}$'
          or nullif(btrim(coalesce(source.time_zone, '')), '') is null
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.google_ads_connection_id = source.id
          )
        )
    )
  then
    raise exception 'Connected reporting sources are not covered exactly once and healthy.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        (
          binding.shopify_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'shopify'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.shopify_currency
                from public.client_shopify_connections source
                where source.id = binding.shopify_connection_id
              )
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'google_ads'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.currency
                from public.client_google_ads_connections source
                where source.id = binding.google_ads_connection_id
              )
          )
        )
      )
  ) then
    raise exception 'Every bound source requires a current post-binding sync receipt.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_sync_states shopify_receipt
      on shopify_receipt.binding_id = binding.id
     and shopify_receipt.source_type = 'shopify'
    left join public.client_reporting_sync_states google_receipt
      on google_receipt.binding_id = binding.id
     and google_receipt.source_type = 'google_ads'
    cross join lateral (
      select count(*)::integer as day_count,
             count(distinct metric.day)::integer as distinct_day_count,
             count(metric.computed_at)::integer as computed_count,
             min(metric.day) as min_day,
             max(metric.day) as max_day,
             min(metric.computed_at) as min_computed_at,
             max(metric.computed_at) as max_computed_at
      from public.daily_metrics metric
      where metric.ad_account_id = binding.ad_account_id
        and metric.day between current_date - 90 and current_date - 1
    ) materialized
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        materialized.day_count <> 90
        or materialized.distinct_day_count <> 90
        or materialized.computed_count <> 90
        or materialized.min_day is distinct from current_date - 90
        or materialized.max_day is distinct from current_date - 1
        or materialized.min_computed_at is null
        or materialized.min_computed_at <= binding.bound_at
        or materialized.max_computed_at is null
        or (
          binding.shopify_connection_id is not null
          and (
            shopify_receipt.last_success_at is null
            or materialized.max_computed_at > shopify_receipt.last_success_at
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and (
            google_receipt.last_success_at is null
            or materialized.max_computed_at > google_receipt.last_success_at
          )
        )
      )
  ) then
    raise exception 'Every active binding requires complete receipt-owned current 90-day facts.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_reporting_bindings binding
    join public.client_google_ads_connections source
      on source.id = binding.google_ads_connection_id
    join public.ad_accounts account on account.id = binding.ad_account_id
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.google_ads_connection_id is not null
      and (
        source.client_id is distinct from p_client_id
        or account.client_id is distinct from p_client_id
        or account.status not in ('active', 'suspended')
        or account.google_ads_customer_id is distinct from
             public.normalize_google_ads_customer_id(source.windsor_account_id)
        or account.currency is distinct from source.currency
        or not exists (
          select 1 from public.ad_account_billing_starts billing_start
          where billing_start.ad_account_id = account.id
            and billing_start.google_ads_customer_id = account.google_ads_customer_id
            and billing_start.currency = account.currency
        )
        or exists (
          select 1 from public.ad_account_billing_ends billing_end
          where billing_end.ad_account_id = account.id
        )
      )
  ) then
    raise exception 'Every Google source requires an open exact immutable billing start.'
      using errcode = '23514';
  end if;

  reactivation_time := clock_timestamp();
  perform set_config(
    'dropscale.reporting_cutover_reactivation',
    p_client_id::text,
    true
  );
  update public.client_rollout_states
  set operational_surface = 'v2_active',
      updated_by = p_admin_id,
      updated_at = reactivation_time
  where client_id = p_client_id
    and operational_surface = 'rollback_legacy';
  if not found then
    raise exception 'The incident repair lost its serialized state.'
      using errcode = '40001';
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    cutover_session_id,
    'reporting_reactivation',
    'admin',
    p_admin_id,
    jsonb_build_object(
      'reason', normal_reason,
      'reportingCutoverAt', rollout.reporting_cutover_at,
      'reportingCutoverReason', rollout.reporting_cutover_reason,
      'reportingActivationEventId', activation_event_id,
      'reportingRollbackEventId', rollback_event_id,
      'reportingRollbackAt', rollback_time,
      'reportingRollbackReason', rollback_reason,
      'reportingReactivationAt', reactivation_time
    )
  );

  return p_client_id;
end
$$;

revoke all on function public.reactivate_client_reporting_cutover(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reactivate_client_reporting_cutover(uuid, uuid, text)
  to service_role;

revoke all on function public.guard_client_reporting_cutover_marker()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_cutover_event()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
