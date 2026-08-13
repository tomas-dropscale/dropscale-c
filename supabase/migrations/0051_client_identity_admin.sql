-- Client identity details and reversible admin removal.
-- Removing a client blocks portal access and closes bearer links, but keeps
-- reporting connections, credentials, mappings, billing and audit history.

alter table public.portal_clients
  add column if not exists discord_handle text;

alter table public.portal_clients
  drop constraint if exists portal_clients_discord_handle_shape,
  add constraint portal_clients_discord_handle_shape check (
    discord_handle is null
    or (
      discord_handle = btrim(discord_handle)
      and length(discord_handle) between 2 and 64
      and left(discord_handle, 1) <> '@'
      and discord_handle !~ '[[:space:][:cntrl:]]'
      and lower(discord_handle) !~ '^(https?://|www[.]|discord(app)?[.]com/)'
    )
  );

comment on column public.portal_clients.discord_handle is
  'Optional Discord username, stored without a leading @.';

alter table public.client_onboarding_sessions
  add column if not exists discord_handle text;

alter table public.client_onboarding_sessions
  drop constraint if exists client_onboarding_discord_handle_shape,
  add constraint client_onboarding_discord_handle_shape check (
    discord_handle is null
    or (
      discord_handle = btrim(discord_handle)
      and length(discord_handle) between 2 and 64
      and left(discord_handle, 1) <> '@'
      and discord_handle !~ '[[:space:][:cntrl:]]'
      and lower(discord_handle) !~ '^(https?://|www[.]|discord(app)?[.]com/)'
    )
  );

comment on column public.client_onboarding_sessions.discord_handle is
  'Discord username supplied while claiming a new client identity.';

-- Most portal RLS policies delegate to this predicate. A rejected workspace
-- must therefore stop authorizing both its owner and every partner, while a
-- rejected partner must remain unable to enter somebody else's workspace.
create or replace function public.is_client_member(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.portal_clients workspace
    where workspace.id = p_client_id
      and workspace.approval_status <> 'rejected'
      and (
        workspace.id = auth.uid()
        or exists (
          select 1
          from public.client_members membership
          join public.portal_clients viewer on viewer.id = membership.member_id
          where membership.client_id = workspace.id
            and membership.member_id = auth.uid()
            and viewer.approval_status <> 'rejected'
        )
      )
  );
$$;

-- Keep self SELECT available for the portal gate, but a removed client may no
-- longer mutate even the identity row that records their rejected state.
drop policy if exists portal_clients_update_self on public.portal_clients;
create policy portal_clients_update_self on public.portal_clients
  for update using (
    (id = auth.uid() and approval_status <> 'rejected') or public.is_admin()
  ) with check (
    (id = auth.uid() and approval_status <> 'rejected') or public.is_admin()
  );

-- Keep the six-argument overload during the migration-first deployment window:
-- the previous app bundle may still call it until the new Worker is active.
-- The new account route calls this seven-argument overload and requires
-- Discord; the compatibility overload remains service-role-only and can be
-- removed in a later migration after the new bundle is established.
create or replace function public.claim_client_onboarding_identity(
  p_session_id uuid,
  p_token_hash text,
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_discord_handle text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  normal_email text := lower(btrim(coalesce(p_email, '')));
  normal_discord text := nullif(
    regexp_replace(btrim(coalesce(p_discord_handle, '')), '^@', ''),
    ''
  );
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can claim an onboarding identity.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status not in ('pending', 'collecting')
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or target.failed_attempts >= 10
  then
    raise exception 'Onboarding invitation is not available.' using errcode = 'P0002';
  end if;
  if p_user_id is null or not exists (
    select 1 from auth.users
    where id = p_user_id and lower(email) = normal_email
  ) then
    raise exception 'Identity not found.' using errcode = 'P0002';
  end if;
  if target.mode = 'new_client' and exists (
    select 1 from public.portal_clients where id = p_user_id
  ) then
    raise exception 'This identity already belongs to a portal client.' using errcode = '23505';
  end if;
  if target.target_client_id is not null and target.target_client_id <> p_user_id then
    raise exception 'This invitation belongs to another client.' using errcode = '42501';
  end if;
  if target.claimed_user_id is not null and target.claimed_user_id <> p_user_id then
    raise exception 'This invitation has already been claimed.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_first_name, ''))) not between 1 and 80
    or length(btrim(coalesce(p_last_name, ''))) not between 1 and 80
    or length(normal_email) not between 3 and 320
    or position('@' in normal_email) <= 1
    or (target.mode = 'new_client' and normal_discord is null)
    or (
      normal_discord is not null
      and (
        length(normal_discord) not between 2 and 64
        or left(normal_discord, 1) = '@'
        or normal_discord ~ '[[:space:][:cntrl:]]'
        or lower(normal_discord) ~ '^(https?://|www[.]|discord(app)?[.]com/)'
      )
    )
  then
    raise exception 'Invalid client identity.' using errcode = '22023';
  end if;

  update public.client_onboarding_sessions
  set claimed_user_id = p_user_id,
      first_name = btrim(p_first_name),
      last_name = btrim(p_last_name),
      email = normal_email,
      discord_handle = normal_discord,
      status = 'collecting',
      identity_created_at = coalesce(identity_created_at, now()),
      updated_at = now(),
      last_error_code = null
  where id = target.id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (target.id, 'identity_claimed', 'client', p_user_id);
  return target.id;
end
$$;

revoke all on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text, text
) to service_role;

revoke all on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text
) to service_role;

-- Reviewing a new-client setup grants dashboard access in the same action.
-- Asset-bearing setups remain reviewed / ready for cutover until the reporting
-- adapter is enabled; account-only setups may still become fully active.
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

create or replace function public.update_portal_client_identity(
  p_client_id uuid,
  p_full_name text,
  p_email text,
  p_discord_handle text,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normal_name text := regexp_replace(btrim(coalesce(p_full_name, '')), '[[:space:]]+', ' ', 'g');
  normal_email text := lower(btrim(coalesce(p_email, '')));
  normal_discord text := nullif(
    regexp_replace(btrim(coalesce(p_discord_handle, '')), '^@', ''),
    ''
  );
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can update a client profile.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_client_id is null or not exists (
    select 1 from public.portal_clients where id = p_client_id
  ) then
    raise exception 'Client profile not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.profiles where id = p_client_id and role = 'admin') then
    raise exception 'Admin profiles cannot be managed as clients.' using errcode = '42501';
  end if;
  if length(normal_name) not between 1 and 160
    or length(normal_email) not between 3 and 320
    or position('@' in normal_email) <= 1
    or (
      normal_discord is not null
      and (
        length(normal_discord) not between 2 and 64
        or left(normal_discord, 1) = '@'
        or normal_discord ~ '[[:space:][:cntrl:]]'
        or lower(normal_discord) ~ '^(https?://|www[.]|discord(app)?[.]com/)'
      )
    )
  then
    raise exception 'Invalid client profile.' using errcode = '22023';
  end if;

  update public.portal_clients
  set full_name = normal_name,
      email = normal_email,
      discord_handle = normal_discord
  where id = p_client_id;
  return p_client_id;
end
$$;

revoke all on function public.update_portal_client_identity(
  uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.update_portal_client_identity(
  uuid, text, text, text, uuid
) to service_role;

create or replace function public.archive_portal_client(
  p_client_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  update public.client_rollout_states
  set operational_surface = 'legacy_only',
      onboarding_session_id = null,
      updated_by = p_admin_id,
      updated_at = now()
  where client_id = p_client_id;

  return p_client_id;
end
$$;

revoke all on function public.archive_portal_client(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.archive_portal_client(uuid, uuid)
  to service_role;
