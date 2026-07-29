-- =============================================================================
-- 0018 — creatives the CLIENT hands in.
--
-- The opposite direction to creative_deliveries (0001), which is the agency
-- handing finished creatives down. This is the client saying "here are the
-- videos, go build campaigns with them".
--
-- Links, not files. The creatives are 200MB videos that already live in the
-- client's own Drive or Dropbox, so a link is the honest primitive: nothing to
-- store, nothing to pay for, no upload that can die at 80% on a hotel wifi. It
-- also means this table holds no file the agency can lose.
--
-- Attached to an ad_account, not to a client: a submission always belongs to
-- ONE store, which is what makes the admin view group itself by store without
-- anybody having to pick from a dropdown.
-- =============================================================================

create table if not exists public.creative_submissions (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,

  -- Who handed it in. Nullable and null-on-delete so removing a portal login
  -- never deletes the work they submitted — a sócio can leave and the batch
  -- they sent stays attributable to the store.
  submitted_by uuid references public.portal_clients (id) on delete set null,

  -- What it is, e.g. "July — 5 UGC hooks".
  title text not null,
  -- Where it is. http/https only, enforced by the guard below.
  url text not null,
  -- Anything the team needs to know: which product, which angle, what to avoid.
  notes text,

  -- new      → handed in, nobody has looked yet
  -- in_use   → turned into a campaign; the client sees their work landed
  -- rejected → not usable; `review_notes` says why
  status text not null default 'new' check (status in ('new', 'in_use', 'rejected')),
  review_notes text,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists creative_submissions_account_idx
  on public.creative_submissions (ad_account_id, created_at desc);

-- The admin view's default filter is "what have I not dealt with", so that is
-- the slice worth an index of its own.
create index if not exists creative_submissions_new_idx
  on public.creative_submissions (created_at desc)
  where status = 'new';

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.creative_submissions enable row level security;

-- Read: anyone who can open the store (owner or sócio, migration 0015), plus
-- the team. owns_ad_account() is the single chain predicate — see 0015.
drop policy if exists creative_submissions_select on public.creative_submissions;
create policy creative_submissions_select on public.creative_submissions
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

-- Insert: only for your own store, and only as 'new'. A client cannot hand
-- something in pre-marked as already in use.
drop policy if exists creative_submissions_insert on public.creative_submissions;
create policy creative_submissions_insert on public.creative_submissions
  for insert with check (
    (public.owns_ad_account(ad_account_id) and status = 'new') or public.is_admin()
  );

-- Update: the client may fix a wrong link while nobody has reviewed it yet;
-- the team may review anything. The trigger below is what stops the client's
-- own UPDATE from touching the review columns — RLS authorises rows, not
-- columns, so without it a client could mark their own work 'in_use'.
drop policy if exists creative_submissions_update on public.creative_submissions;
create policy creative_submissions_update on public.creative_submissions
  for update using (
    (public.owns_ad_account(ad_account_id) and status = 'new') or public.is_admin()
  )
  with check (public.owns_ad_account(ad_account_id) or public.is_admin());

-- Delete: a client may withdraw a submission the team has not acted on. This
-- is deliberately NOT the "clients never delete" case from 0001 — that rule
-- guards the AGENCY's records, and a batch of the client's own videos is not
-- one. Same reasoning as the COGS tables in 0009. Once it is in_use or
-- rejected it is part of the history and only the team can remove it.
drop policy if exists creative_submissions_delete on public.creative_submissions;
create policy creative_submissions_delete on public.creative_submissions
  for delete using (
    (public.owns_ad_account(ad_account_id) and status = 'new') or public.is_admin()
  );

-- -----------------------------------------------------------------------------
-- Guard: the review columns are the team's, and the link has to be a link.
--
-- The url ends up as an href an admin clicks. Refusing anything but http/https
-- here — not only in the form — is what keeps `javascript:` and `data:` out of
-- that anchor even if a row is written straight through the API.
-- -----------------------------------------------------------------------------
create or replace function public.guard_creative_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.title := trim(new.title);
  new.url := trim(new.url);

  if new.title = '' then
    raise exception 'A submission needs a name.';
  end if;
  if new.url !~* '^https?://[^\s]+$' then
    raise exception 'The link has to start with http:// or https://';
  end if;

  -- Trusted contexts (SQL editor, migrations, service role) have no uid.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'new' then
      raise exception 'Only the team can set a submission''s status.';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     or new.review_notes is distinct from old.review_notes
     or new.reviewed_at is distinct from old.reviewed_at
     or new.reviewed_by is distinct from old.reviewed_by then
    raise exception 'Only the team can review a submission.';
  end if;

  -- Re-pointing a submission at another store would move it out from under the
  -- policy that authorised the edit.
  if new.ad_account_id is distinct from old.ad_account_id then
    raise exception 'A submission cannot be moved to another store.';
  end if;

  return new;
end;
$$;

drop trigger if exists creative_submissions_guard on public.creative_submissions;
create trigger creative_submissions_guard
  before insert or update on public.creative_submissions
  for each row execute function public.guard_creative_submission();
