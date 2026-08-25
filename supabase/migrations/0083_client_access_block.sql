-- =============================================================================
-- 0083 - Reversible portal access block.
--
-- Archiving (0051/0080) is a one-way door: it sets approval_status='rejected',
-- suspends the client's ad accounts and stops them being billable, and every
-- approval path in the codebase deliberately refuses to revive a rejected
-- identity. That is the right shape for a client who leaves for good.
--
-- It is the wrong shape for "stop this client opening the dashboard until they
-- settle an invoice". That needs a switch the team can flip back, and it must
-- NOT touch billing: a blocked client keeps accruing spend and stays billable,
-- which is the whole point of blocking them.
--
-- So access_blocked is deliberately independent of approval_status. It gates
-- the portal only. Nothing in reporting, sync or billing reads it.
-- =============================================================================

alter table public.portal_clients
  add column if not exists access_blocked boolean not null default false,
  add column if not exists access_blocked_at timestamptz,
  add column if not exists access_blocked_by uuid references public.profiles(id) on delete set null;

comment on column public.portal_clients.access_blocked is
  'Reversible portal lockout. Independent of approval_status; never affects billing or syncs.';

-- The audit trail is part of the state, not an optional extra: a blocked row
-- always records when and by whom, and clearing the block clears both.
alter table public.portal_clients
  drop constraint if exists portal_clients_access_block_shape;
alter table public.portal_clients
  add constraint portal_clients_access_block_shape check (
    (access_blocked = false and access_blocked_at is null and access_blocked_by is null)
    or (access_blocked = true and access_blocked_at is not null and access_blocked_by is not null)
  );

create index if not exists portal_clients_access_blocked_idx
  on public.portal_clients(access_blocked)
  where access_blocked = true;

-- ---------------------------------------------------------------------------
-- The client can update their own portal_clients row (policy
-- portal_clients_update_self, 0051). Without this guard a blocked client would
-- simply `update portal_clients set access_blocked = false` on their own row
-- and walk straight back in. Same shape as guard_ad_account_status (0001).
-- ---------------------------------------------------------------------------
create or replace function public.guard_portal_client_access_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Trusted contexts (SQL editor, migrations, service role) have no uid.
  if auth.uid() is null then
    return new;
  end if;
  if new.access_blocked is distinct from old.access_blocked and not public.is_admin() then
    raise exception 'Only the team can change a client''s portal access.'
      using errcode = '42501';
  end if;
  if (
    new.access_blocked_at is distinct from old.access_blocked_at
    or new.access_blocked_by is distinct from old.access_blocked_by
  ) and not public.is_admin() then
    raise exception 'Only the team can change a client''s portal access.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_clients_guard_access_block on public.portal_clients;
create trigger portal_clients_guard_access_block
  before update on public.portal_clients
  for each row execute function public.guard_portal_client_access_block();

-- ---------------------------------------------------------------------------
-- The only supported way to flip the switch. Server-side, admin-verified, and
-- idempotent: blocking an already-blocked client keeps the original timestamp
-- so the audit trail records when the lockout actually began.
-- ---------------------------------------------------------------------------
create or replace function public.set_portal_client_access_block(
  p_client_id uuid,
  p_admin_id uuid,
  p_blocked boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can change portal access.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_blocked is null then
    raise exception 'A block decision is required.' using errcode = '22004';
  end if;
  if p_client_id is null or not exists (
    select 1 from public.portal_clients where id = p_client_id for update
  ) then
    raise exception 'Client profile not found.' using errcode = 'P0002';
  end if;
  -- Staff keep their own way in; locking an admin out of the portal would be a
  -- support incident, not a business decision.
  if exists (select 1 from public.profiles where id = p_client_id and role = 'admin') then
    raise exception 'Admin profiles cannot be blocked as clients.' using errcode = '42501';
  end if;

  update public.portal_clients
  set access_blocked = p_blocked,
      access_blocked_at = case
        when p_blocked then coalesce(access_blocked_at, now())
        else null
      end,
      access_blocked_by = case
        when p_blocked then coalesce(access_blocked_by, p_admin_id)
        else null
      end
  where id = p_client_id;

  return p_client_id;
end;
$$;

revoke all on function public.set_portal_client_access_block(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_portal_client_access_block(uuid, uuid, boolean)
  to service_role;
