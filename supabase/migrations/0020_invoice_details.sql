-- =============================================================================
-- 0020 — the details a client's invoice has to carry.
--
-- Invoices are issued out of Hong Kong, where they are a legal document rather
-- than a courtesy: they have to show who is being billed and where. Until now
-- the Stripe customer was created from the PORTAL LOGIN's name and email —
-- "Tomás", the person who signed up — with no address at all. That is not a
-- company anybody can put through their books.
--
-- So the billing profile gains the invoice identity. Deliberately separate from
-- portal_clients.full_name: the person who logs in and the entity that pays are
-- routinely not the same, and a client renaming themselves in the portal must
-- never quietly re-issue future invoices to a different name.
--
-- Structured address fields rather than one free-text block, because Stripe's
-- customer address is structured and that is what ends up printed on the PDF.
-- A textarea would have to be parsed back apart, badly, at exactly the moment
-- it matters.
-- =============================================================================

alter table public.billing_profiles
  -- Legal name of the entity being invoiced: the company, or the person when
  -- the profile is an individual.
  add column if not exists billing_name text,
  -- VAT / company registration number. Optional, and printed as an invoice
  -- custom field rather than registered as a Stripe tax id — Stripe demands a
  -- jurisdiction-specific type for those, which we cannot infer reliably.
  add column if not exists tax_id text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists address_city text,
  add column if not exists address_postal_code text,
  -- Region / province / state. Optional: most of Europe has no such thing.
  add column if not exists address_state text,
  -- ISO 3166-1 alpha-2, upper-case. Stripe wants exactly this shape.
  add column if not exists address_country text;

comment on column public.billing_profiles.billing_name is
  'Legal name printed on the invoice. Separate from the portal login name on purpose — the person signing in is often not the entity being billed.';

-- Normalise on the way in, so nothing downstream has to.
--
-- The country is the one that would actually break: Stripe rejects anything but
-- a two-letter code, and the failure surfaces as an invoice that cannot be
-- finalised — days later, in a cron, to nobody.
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

  if new.address_country is not null and new.address_country !~ '^[A-Z]{2}$' then
    raise exception 'Country must be a two-letter code, e.g. PT or HK.';
  end if;

  return new;
end;
$$;

drop trigger if exists billing_profiles_guard on public.billing_profiles;
create trigger billing_profiles_guard
  before insert or update on public.billing_profiles
  for each row execute function public.guard_billing_profile();
