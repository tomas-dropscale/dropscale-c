-- =============================================================================
-- 0021 — collection_url on creative_submissions, for databases that already ran
-- an earlier 0018.
--
-- Why this file exists at all: the column was added by EDITING 0018 after that
-- migration had already been applied. `create table if not exists` does nothing
-- to a table that exists, so the column never appeared, and the portal failed
-- with "Could not find the 'collection_url' column of 'creative_submissions' in
-- the schema cache" — PostgREST reporting, accurately, that it is not there.
--
-- Migrations that have run are history and do not get edited. This is the
-- correction, appended where it belongs.
--
-- A no-op on any database that applied the current 0018: the column is added
-- only if missing, and the function below is character-for-character the one
-- 0018 already defines. Safe to run either way, and safe to run twice.
-- =============================================================================

alter table public.creative_submissions
  add column if not exists collection_url text;

comment on column public.creative_submissions.collection_url is
  'The Shopify collection these creatives advertise. The campaign built from the batch carries this URL in its name, which is how revenue share is attributed (migration 0010).';

-- The guard has to know about the column too. A database on the old 0018 has the
-- old function, which neither trims the value nor checks its scheme — and that
-- url ends up as an href somebody clicks.
create or replace function public.guard_creative_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.title := trim(new.title);
  new.url := trim(new.url);
  new.collection_url := nullif(trim(coalesce(new.collection_url, '')), '');

  if new.title = '' then
    raise exception 'A submission needs a name.';
  end if;
  if new.url !~* '^https?://[^\s]+$' then
    raise exception 'The link has to start with http:// or https://';
  end if;

  -- Scheme-checked but NOT required to contain /collections/. A link that can't
  -- be parsed into a handle is flagged in the admin inbox instead: the agency is
  -- who needs to notice, and a client should never be blocked from handing work
  -- in over the shape of a URL.
  if new.collection_url is not null and new.collection_url !~* '^https?://[^\s]+$' then
    raise exception 'The collection link has to start with http:// or https://';
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

-- The error you saw was PostgREST's cached schema, not the database. Supabase
-- usually reloads on its own after DDL; this makes it immediate so the portal
-- works on the next request instead of the next few minutes.
notify pgrst, 'reload schema';
