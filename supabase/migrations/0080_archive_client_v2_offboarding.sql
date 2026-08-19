-- Archiving a client failed for every V2-active client: archive_portal_client
-- force-reset client_rollout_states.operational_surface to 'legacy_only', and
-- guard_client_reporting_cutover_marker (correctly) forbids that transition
-- for a marker-active surface. The marker is durable history — archiving now
-- leaves it untouched and revokes access via approval_status alone. Archiving
-- additionally suspends the client's active ad accounts so an offboarded
-- client stops accruing synced spend while the final closed week stays
-- billable (the established suspended-account semantics).

CREATE OR REPLACE FUNCTION public.archive_portal_client(p_client_id uuid, p_admin_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can remove a client.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_client_id is null or not exists (
    select 1 from public.portal_clients where id = p_client_id for update
  ) then
    raise exception 'Client profile not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.profiles where id = p_client_id and role = 'admin') then
    raise exception 'Admin profiles cannot be removed as clients.' using errcode = '42501';
  end if;

  update public.portal_clients
  set approval_status = 'rejected',
      approved_at = null,
      approved_by = null
  where id = p_client_id;

  perform session.id
  from public.client_onboarding_sessions session
  where session.status in ('pending', 'collecting')
    and (
      session.target_client_id = p_client_id
      or session.claimed_user_id = p_client_id
    )
  order by session.id
  for update;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  )
  select session.id, 'invitation_revoked', 'admin', p_admin_id,
         jsonb_build_object('reason', 'client_archived')
  from public.client_onboarding_sessions session
  where session.status in ('pending', 'collecting')
    and (
      session.target_client_id = p_client_id
      or session.claimed_user_id = p_client_id
    );

  delete from public.client_onboarding_secrets secret
  where exists (
    select 1
    from public.client_onboarding_sessions session
    where session.id = secret.session_id
      and session.status in ('pending', 'collecting')
      and (
        session.target_client_id = p_client_id
        or session.claimed_user_id = p_client_id
      )
  );

  update public.client_onboarding_sessions session
  set status = 'revoked',
      invite_token_hash = null,
      invite_expires_at = null,
      revoked_at = now(),
      updated_at = now(),
      last_error_code = null
  where session.status in ('pending', 'collecting')
    and (
      session.target_client_id = p_client_id
      or session.claimed_user_id = p_client_id
    );

  -- A markered (V2) surface is durable cutover history and its state machine
  -- (guard_client_reporting_cutover_marker) forbids a generic reset — this
  -- exact reset is why archiving any v2_active client failed. Access is
  -- revoked by approval_status; only unmarkered rollout rows get tidied.
  update public.client_rollout_states
  set operational_surface = 'legacy_only',
      onboarding_session_id = null,
      updated_by = p_admin_id,
      updated_at = now()
  where client_id = p_client_id
    and reporting_cutover_at is null;

  -- Offboarding (owner request 2026-08-19): a client leaving the agency must
  -- stop accruing spend in syncs and billing. Suspended keeps the accounts'
  -- history and leaves the final closed week billable.
  update public.ad_accounts
  set status = 'suspended'
  where client_id = p_client_id
    and status = 'active';

  return p_client_id;
end
$function$
;
