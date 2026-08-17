-- =============================================================================
-- 0073 — persist the reporting snapshot failure message.
--
-- A failed provider family stored only an error code; the actual provider
-- error lived in a console line on an ephemeral Worker isolate, which in
-- practice meant it was lost (Workers observability is off and tails are
-- best-effort). The 2026-08-17 collection-sales incident needed four capture
-- attempts and still ended without the message. Failures now land in the
-- row's `message` column, truncated, prefixed so a later success clears it.
-- =============================================================================

create or replace function public.fail_admin_reporting_snapshot_refresh(
  p_family text,
  p_scope_account_id uuid,
  p_from_day date,
  p_to_day date,
  p_authority_key text,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  changed integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can fail a snapshot refresh.'
      using errcode = '42501';
  end if;
  if p_lease_token is null
    or coalesce(p_error_code, '') !~ '^[a-z0-9_]{1,80}$'
  then
    raise exception 'Invalid admin reporting snapshot failure.'
      using errcode = '22023';
  end if;

  update public.admin_reporting_range_snapshots snapshot
  set last_error_code = p_error_code,
      message = case
        when nullif(btrim(coalesce(p_error_message, '')), '') is null
          then snapshot.message
        else left('Last failure: ' || btrim(p_error_message), 600)
      end,
      lease_token = null,
      lease_expires_at = null
  where snapshot.family = p_family
    and snapshot.scope_account_id = p_scope_account_id
    and snapshot.from_day = p_from_day
    and snapshot.to_day = p_to_day
    and snapshot.authority_key = p_authority_key
    and snapshot.lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end
$function$;
