-- =============================================================================
-- 0057 - Purpose-bound, audited rollback of normalized reporting authority.
--
-- The original cutover marker remains immutable evidence. A rollback changes
-- only which reporting surface is authoritative and records one immutable
-- onboarding event; bindings, facts and every financial boundary stay intact.
-- =============================================================================

alter table public.client_onboarding_events
  drop constraint if exists client_onboarding_events_event_type_check;
alter table public.client_onboarding_events
  add constraint client_onboarding_events_event_type_check check (event_type in (
    'invitation_created', 'invitation_rotated', 'identity_claimed',
    'shopify_connected', 'google_connected', 'assets_mapped',
    'submitted', 'reviewed', 'activated', 'reporting_rollback',
    'invitation_revoked', 'connections_revoked',
    'verification_succeeded', 'verification_failed'
  ));

create unique index client_onboarding_events_reporting_rollback_session_uq
  on public.client_onboarding_events(session_id)
  where event_type = 'reporting_rollback';

create or replace function public.guard_client_reporting_cutover_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purpose_bound_marker_write boolean := false;
  purpose_bound_rollback boolean := false;
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

  -- Keep the historical reactivation error explicit. Re-entering V2 needs a
  -- future workflow that revalidates bindings, health and fresh receipts.
  if old.reporting_cutover_at is not null
    and old.operational_surface <> 'v2_active'
    and new.operational_surface = 'v2_active'
    and not purpose_bound_marker_write
  then
    raise exception 'A rolled-back reporting cutover cannot be reactivated generically.'
      using errcode = '23514';
  end if;

  -- Once a durable marker exists, the sole generic surface transition is the
  -- exact v2_active -> rollback_legacy change made by the rollback RPC below.
  -- The marker and onboarding-session identity stay untouched.
  if old.reporting_cutover_at is not null
    and new.operational_surface is distinct from old.operational_surface
  then
    if old.operational_surface <> 'v2_active'
      or new.operational_surface <> 'rollback_legacy'
      or not purpose_bound_rollback
      or new.onboarding_session_id is distinct from old.onboarding_session_id
      or new.updated_by is null
      or not exists (
        select 1 from public.profiles profile
        where profile.id = new.updated_by and profile.role = 'admin'
      )
      or new.updated_at < clock_timestamp() - interval '1 minute'
      or new.updated_at > clock_timestamp() + interval '1 minute'
    then
      raise exception 'A marker-active reporting cutover may only enter rollback through its purpose-bound RPC.'
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
    ) or old.event_type = 'reporting_rollback';
  end if;
  if tg_op <> 'DELETE' then
    new_is_reporting := (
      new.event_type = 'activated'
      and new.details ->> 'reportingBindings' = 'true'
    ) or new.event_type = 'reporting_rollback';
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

    if new.event_type = 'reporting_rollback' then
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

create or replace function public.rollback_client_reporting_cutover(
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
  cutover_session_id uuid;
  cutover_event_count integer;
  rollback_time timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can roll back a cutover.'
      using errcode = '42501';
  end if;
  if p_client_id is null
    or not exists (
      select 1 from public.profiles where id = p_admin_id and role = 'admin'
    )
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting rollback request.' using errcode = '22023';
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

  select count(*)::integer, min(event.session_id::text)::uuid
    into cutover_event_count, cutover_session_id
  from public.client_onboarding_events event
  join public.client_onboarding_sessions session
    on session.id = event.session_id
  where session.claimed_user_id = p_client_id
    and event.event_type = 'activated'
    and event.actor_type = 'admin'
    and event.actor_id = rollout.reporting_cutover_by
    and event.details ->> 'reportingBindings' = 'true'
    and event.details ->> 'reason' = rollout.reporting_cutover_reason
    and event.details ->> 'reportingCutoverAt'
          = (to_jsonb(rollout.reporting_cutover_at) #>> '{}');
  if cutover_event_count <> 1 or cutover_session_id is null then
    raise exception 'The reporting cutover needs exactly one matching activation audit event.'
      using errcode = '23514';
  end if;

  if rollout.operational_surface = 'rollback_legacy' then
    if exists (
      select 1
      from public.client_onboarding_events event
      where event.session_id = cutover_session_id
        and event.event_type = 'reporting_rollback'
        and event.actor_type = 'admin'
        and event.actor_id = p_admin_id
        and event.details ->> 'reason' = normal_reason
        and event.details ->> 'reportingCutoverAt'
              = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
        and event.details ->> 'reportingCutoverReason'
              = rollout.reporting_cutover_reason
    ) then
      return p_client_id;
    end if;
    raise exception 'Reporting rollback is already recorded with different authority or reason.'
      using errcode = '23514';
  end if;
  if rollout.operational_surface <> 'v2_active' then
    raise exception 'Only a marker-active reporting cutover can be rolled back.'
      using errcode = '23514';
  end if;
  rollback_time := clock_timestamp();
  perform set_config(
    'dropscale.reporting_cutover_rollback',
    p_client_id::text,
    true
  );
  update public.client_rollout_states
  set operational_surface = 'rollback_legacy',
      updated_by = p_admin_id,
      updated_at = rollback_time
  where client_id = p_client_id
    and operational_surface = 'v2_active';
  if not found then
    raise exception 'The reporting rollback lost its serialized state.'
      using errcode = '40001';
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    cutover_session_id,
    'reporting_rollback',
    'admin',
    p_admin_id,
    jsonb_build_object(
      'reason', normal_reason,
      'reportingCutoverAt', rollout.reporting_cutover_at,
      'reportingCutoverReason', rollout.reporting_cutover_reason,
      'reportingRollbackAt', rollback_time
    )
  );

  return p_client_id;
end
$$;

revoke all on function public.rollback_client_reporting_cutover(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rollback_client_reporting_cutover(uuid, uuid, text)
  to service_role;

revoke all on function public.guard_client_reporting_cutover_marker()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_cutover_event()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
