-- Account-only onboarding creates a real workspace without pretending that it
-- is connected. Pending is now an internal audit state: only archived clients
-- are blocked from their portal or from receiving an Add assets invitation.

create or replace function public.can_open_workspace(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_client_member(p_client_id)
    and exists (
      select 1
      from public.portal_clients client
      where client.id = p_client_id
        and client.approval_status <> 'rejected'
    );
$$;

create or replace function public.materialize_account_only_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.mode = 'new_client'
    and new.status = 'submitted'
    and cardinality(new.requested_assets) = 0
    and new.claimed_user_id is not null
  then
    insert into public.portal_clients (
      id, full_name, email, discord_handle, approval_status
    ) values (
      new.claimed_user_id,
      btrim(new.first_name || ' ' || new.last_name),
      new.email,
      new.discord_handle,
      'pending'
    ) on conflict (id) do nothing;
  end if;
  return new;
end
$$;

revoke all on function public.materialize_account_only_portal_client()
  from public, anon, authenticated, service_role;

drop trigger if exists client_onboarding_materializes_account_only_workspace
  on public.client_onboarding_sessions;
create trigger client_onboarding_materializes_account_only_workspace
  after update of status, claimed_user_id on public.client_onboarding_sessions
  for each row execute function public.materialize_account_only_portal_client();

-- Repair already-submitted account-only identities. They remain pending until
-- a verified connection invokes the 0063 automatic-approval invariant.
insert into public.portal_clients (
  id, full_name, email, discord_handle, approval_status
)
select
  session.claimed_user_id,
  btrim(session.first_name || ' ' || session.last_name),
  session.email,
  session.discord_handle,
  'pending'
from public.client_onboarding_sessions session
where session.mode = 'new_client'
  and session.status = 'submitted'
  and cardinality(session.requested_assets) = 0
  and session.claimed_user_id is not null
  and not exists (
    select 1 from public.portal_clients client
    where client.id = session.claimed_user_id
  )
on conflict (id) do nothing;

insert into public.client_rollout_states (
  client_id, operational_surface, onboarding_session_id, updated_by
)
select
  session.claimed_user_id,
  'v2_ready_for_cutover',
  session.id,
  session.created_by
from public.client_onboarding_sessions session
join public.portal_clients client on client.id = session.claimed_user_id
where session.mode = 'new_client'
  and session.status = 'submitted'
  and cardinality(session.requested_assets) = 0
  and client.approval_status <> 'rejected'
on conflict (client_id) do nothing;

-- Keep the service RPC honest even if a caller bypasses the roster UI.
create or replace function public.guard_open_onboarding_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_client_id is not null and not exists (
    select 1
    from public.portal_clients client
    where client.id = new.target_client_id
      and client.approval_status <> 'rejected'
  ) then
    raise exception 'Target client not found.' using errcode = 'P0002';
  end if;
  return new;
end
$$;

revoke all on function public.guard_open_onboarding_target()
  from public, anon, authenticated, service_role;

drop trigger if exists client_onboarding_guard_open_target
  on public.client_onboarding_sessions;
create trigger client_onboarding_guard_open_target
  before insert or update of target_client_id on public.client_onboarding_sessions
  for each row execute function public.guard_open_onboarding_target();
