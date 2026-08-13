-- An archived client must not be restorable by replaying a historical review.
create or replace function public.review_client_onboarding_session(
  p_session_id uuid,
  p_admin_id uuid,
  p_activate boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can review onboarding.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found or target.status not in ('submitted', 'reviewed') or target.claimed_user_id is null then
    raise exception 'Submitted onboarding session not found.' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.portal_clients client
    where client.id = target.claimed_user_id
      and client.approval_status = 'rejected'
  ) then
    raise exception 'An archived client cannot be approved from onboarding.'
      using errcode = '23514';
  end if;
  if (p_activate or target.mode = 'new_client') and not exists (
    select 1 from auth.users
    where id = target.claimed_user_id
      and email_confirmed_at is not null
      and lower(email) = target.email
  ) then
    raise exception 'The client must confirm their email before activation.' using errcode = '23514';
  end if;
  if p_activate and cardinality(target.requested_assets) > 0 then
    raise exception 'V2 reporting activation is not available until the portal adapter is enabled.'
      using errcode = '23514';
  end if;

  update public.client_onboarding_sessions
  set status = case when p_activate then 'active' else 'reviewed' end,
      reviewed_at = coalesce(reviewed_at, now()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      activated_at = case when p_activate then coalesce(activated_at, now()) else null end,
      updated_at = now()
  where id = target.id;

  if target.mode = 'new_client' then
    insert into public.portal_clients (
      id, full_name, email, discord_handle,
      approval_status, approved_at, approved_by
    ) values (
      target.claimed_user_id,
      btrim(target.first_name || ' ' || target.last_name),
      target.email,
      target.discord_handle,
      'approved',
      now(),
      p_admin_id
    ) on conflict (id) do update
      set full_name = excluded.full_name,
          email = excluded.email,
          discord_handle = excluded.discord_handle,
          approval_status = 'approved',
          approved_at = coalesce(portal_clients.approved_at, now()),
          approved_by = p_admin_id;
  end if;

  insert into public.client_rollout_states (
    client_id, operational_surface, onboarding_session_id, updated_by
  ) values (
    target.claimed_user_id,
    case when p_activate then 'v2_active' else 'v2_ready_for_cutover' end,
    target.id,
    p_admin_id
  ) on conflict (client_id) do update
    set operational_surface = case
          when p_activate or client_rollout_states.operational_surface = 'v2_active'
            then 'v2_active'
          else 'v2_ready_for_cutover'
        end,
        onboarding_session_id = excluded.onboarding_session_id,
        updated_by = excluded.updated_by,
        updated_at = now();

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (
    target.id, case when p_activate then 'activated' else 'reviewed' end,
    'admin', p_admin_id
  );
  return target.id;
end
$$;

revoke all on function public.review_client_onboarding_session(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.review_client_onboarding_session(uuid, uuid, boolean)
  to service_role;
