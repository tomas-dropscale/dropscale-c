-- =============================================================================
-- 0027 - Repair the pre-v3 schema contract.
--
-- The live project contains objects from migrations after 0020 while some
-- columns from 0019-0021 are absent. Those migrations were edited after an
-- earlier form had already been recorded, so a normal migration push cannot
-- replay them. Reassert the missing contract idempotently before billing v3
-- starts depending on the invoice-recipient fields.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

alter table public.daily_metrics
  add column if not exists attributed_orders integer,
  add column if not exists attributed_revenue numeric;

comment on column public.daily_metrics.attributed_orders is
  'Real orders minus those referred by Instagram/Facebook. NULL means the day has not been recomputed.';
comment on column public.daily_metrics.attributed_revenue is
  'Gross revenue represented by attributed_orders in the account reporting currency.';

alter table public.billing_profiles
  add column if not exists billing_name text,
  add column if not exists tax_id text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists address_city text,
  add column if not exists address_postal_code text,
  add column if not exists address_state text,
  add column if not exists address_country text;

comment on column public.billing_profiles.billing_name is
  'Legal name printed on the invoice, deliberately separate from the portal login name.';

create or replace function public.guard_billing_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.billing_name := nullif(trim(coalesce(new.billing_name, '')), '');
  new.tax_id := nullif(trim(coalesce(new.tax_id, '')), '');
  new.address_line1 := nullif(trim(coalesce(new.address_line1, '')), '');
  new.address_line2 := nullif(trim(coalesce(new.address_line2, '')), '');
  new.address_city := nullif(trim(coalesce(new.address_city, '')), '');
  new.address_postal_code := nullif(trim(coalesce(new.address_postal_code, '')), '');
  new.address_state := nullif(trim(coalesce(new.address_state, '')), '');
  new.address_country := nullif(upper(trim(coalesce(new.address_country, ''))), '');

  if new.address_country is not null
     and new.address_country !~ '^[A-Z]{2}$' then
    raise exception 'Country must be a two-letter code, e.g. PT or HK.';
  end if;

  return new;
end
$$;

drop trigger if exists billing_profiles_guard on public.billing_profiles;
create trigger billing_profiles_guard
  before insert or update on public.billing_profiles
  for each row execute function public.guard_billing_profile();

alter table public.creative_submissions
  add column if not exists collection_url text;

comment on column public.creative_submissions.collection_url is
  'The Shopify collection advertised by this creative submission.';

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
  if new.collection_url is not null
     and new.collection_url !~* '^https?://[^\s]+$' then
    raise exception 'The collection link has to start with http:// or https://';
  end if;

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

  if new.ad_account_id is distinct from old.ad_account_id then
    raise exception 'A submission cannot be moved to another store.';
  end if;

  return new;
end
$$;

drop trigger if exists creative_submissions_guard
  on public.creative_submissions;
create trigger creative_submissions_guard
  before insert or update on public.creative_submissions
  for each row execute function public.guard_creative_submission();

notify pgrst, 'reload schema';
