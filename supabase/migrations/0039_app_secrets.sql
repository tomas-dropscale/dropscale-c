-- =============================================================================
-- 0039 - Operational secrets the team can rotate from the dashboard.
--
-- The research tool's market comparison calls Apify, which needs a token. That
-- token is a credential, not a setting: it is stored ENCRYPTED with the same
-- AES-GCM key that protects the stored Google refresh tokens, it is never sent
-- to a browser, and only the service role can read or write it.
--
-- The table is deliberately generic but tiny. It exists so an operator can
-- replace a rotated token without a deploy — not as a config store.
-- =============================================================================

create table if not exists public.app_secrets (
  key text primary key,
  ciphertext text not null,
  /** Last four characters of the plaintext, for "is this the right token?". */
  hint text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  constraint app_secrets_key_shape check (key ~ '^[a-z][a-z0-9_]{2,63}$')
);

comment on table public.app_secrets is
  'Encrypted operational credentials rotatable from the dashboard. Values never reach a browser; only the service role may read them.';

alter table public.app_secrets enable row level security;
-- No policy at all: RLS with zero policies denies every non-service caller,
-- which is exactly the intent. The service role bypasses RLS.
revoke all on table public.app_secrets from public, anon, authenticated;

/** Store or replace one secret. Admin-attributed, service-role only. */
create or replace function public.set_app_secret(
  p_key text,
  p_ciphertext text,
  p_hint text,
  p_updated_by uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  saved timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can store an application secret.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_updated_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required to store an application secret.'
      using errcode = '42501';
  end if;

  if p_ciphertext is null or btrim(p_ciphertext) = '' then
    raise exception 'An application secret cannot be empty.'
      using errcode = '22023';
  end if;

  insert into public.app_secrets (key, ciphertext, hint, updated_by, updated_at)
  values (p_key, p_ciphertext, p_hint, p_updated_by, now())
  on conflict (key) do update
    set ciphertext = excluded.ciphertext,
        hint = excluded.hint,
        updated_by = excluded.updated_by,
        updated_at = now()
  returning updated_at into saved;

  return saved;
end
$$;

revoke all on function public.set_app_secret(text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.set_app_secret(text, text, text, uuid) to service_role;

-- =============================================================================
-- Market comparison runs.
--
-- The research tool's comparison is the one view that spends money, so every
-- run is recorded and its result cached by (concept, markets): repeating a
-- comparison must be free. The Worker cannot hold a polling job in memory
-- between requests, so the run's context lives here and the browser drives the
-- polling through the state endpoint.
-- =============================================================================

create table if not exists public.research_comparisons (
  key text primary key,
  concept_id text not null,
  geos text[] not null,
  run_id text,
  pairs jsonb not null,
  status text not null default 'running'
    check (status in ('running', 'done', 'error')),
  payload jsonb,
  cost_usd numeric(10,4),
  error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_comparisons_geo_count check (
    array_length(geos, 1) between 2 and 5
  )
);

comment on table public.research_comparisons is
  'Google Trends joint-scale comparisons: one row per concept+markets combination, cached so a repeat costs nothing.';

create index if not exists research_comparisons_run_idx
  on public.research_comparisons (run_id);

alter table public.research_comparisons enable row level security;
-- Service role only, like every other paid-work record here.
revoke all on table public.research_comparisons from public, anon, authenticated;
