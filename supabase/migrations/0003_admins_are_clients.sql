-- =============================================================================
-- Dropscale IO — every admin also holds a portal client identity
--
-- The admin sidebar links to /dashboard ("Client area") and the portal
-- sidebar links back to /admin. That pair only works if an admin actually has
-- a portal_clients row: without one, the portal gate sends them straight back
-- to /admin and the link looks broken — it just bounces.
--
-- This makes the rule true in the database rather than assumed by the UI:
--   * every existing admin gets an approved portal_clients row
--   * anyone promoted to admin from here on gets one automatically
--
-- These rows are approved on sight. An admin approving their own portal
-- access is not an escalation — they already hold every admin policy in the
-- project, including the one that lets them approve anybody.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Backfill: admins who have no portal identity yet.
--
-- Emails can collide with an existing portal client only by id, and id IS the
-- auth user, so `on conflict do nothing` is the whole idempotency story.
-- -----------------------------------------------------------------------------
insert into public.portal_clients (id, full_name, email, avatar_url, approval_status, approved_at)
select
  p.id,
  coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)),
  p.email,
  p.avatar_url,
  'approved',
  now()
from public.profiles p
where p.role = 'admin'
on conflict (id) do nothing;

-- An admin whose row exists but was left pending (e.g. they self-registered
-- through /register first and were promoted afterwards) is approved here too.
update public.portal_clients c
set approval_status = 'approved',
    approved_at = coalesce(c.approved_at, now())
from public.profiles p
where p.id = c.id
  and p.role = 'admin'
  and c.approval_status <> 'approved';

-- -----------------------------------------------------------------------------
-- Keep it true going forward.
--
-- Fires on promotion to admin (and on an admin profile being created), so the
-- "Client area" link is never dead for someone who got their role today.
-- Demotion deliberately does nothing: losing staff access should not silently
-- delete a portal identity that may own ad accounts.
-- -----------------------------------------------------------------------------
create or replace function public.ensure_admin_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from 'admin' then
    return new;
  end if;

  insert into public.portal_clients (id, full_name, email, avatar_url, approval_status, approved_at)
  values (
    new.id,
    coalesce(nullif(trim(new.full_name), ''), split_part(new.email, '@', 1)),
    new.email,
    new.avatar_url,
    'approved',
    now()
  )
  on conflict (id) do update
    set approval_status = 'approved',
        approved_at = coalesce(portal_clients.approved_at, now());

  return new;
end;
$$;

drop trigger if exists profiles_ensure_portal_client on public.profiles;
create trigger profiles_ensure_portal_client
  after insert or update of role on public.profiles
  for each row execute function public.ensure_admin_portal_client();
