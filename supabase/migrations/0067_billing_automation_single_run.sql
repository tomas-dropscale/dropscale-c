-- =============================================================================
-- 0067 - Only one fresh billing automation run may exist at a time.
--
-- Item claims are already fenced, but a second run could immediately reclaim
-- an item after the first run recorded it as blocked. Serialize run creation
-- so concurrent/replayed cron requests become a cheap no-op instead.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

create or replace function public.begin_billing_automation_run(
  p_issuance_enabled boolean
)
returns setof public.billing_automation_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can begin an automation run.'
      using errcode = '42501';
  end if;

  -- The transaction lock closes the check/insert race across every Worker
  -- isolate and deployment. It is held only for this short RPC transaction;
  -- the durable running row is the mutex for the external Stripe work.
  perform pg_advisory_xact_lock(hashtext('billing_automation_single_run'));

  update public.billing_automation_runs abandoned
  set
    status = 'failed',
    finished_at = clock_timestamp(),
    error_count = greatest(abandoned.error_count, 1)
  where abandoned.status = 'running'
    and abandoned.started_at < clock_timestamp() - interval '2 hours';

  -- No row is the intentional idempotent response consumed by the runtime.
  if exists (
    select 1
    from public.billing_automation_runs run
    where run.status = 'running'
  ) then
    return;
  end if;

  return query
  insert into public.billing_automation_runs (issuance_enabled)
  values (coalesce(p_issuance_enabled, false))
  returning *;
end
$$;

revoke all on function public.begin_billing_automation_run(boolean)
  from public, anon, authenticated;
grant execute on function public.begin_billing_automation_run(boolean)
  to service_role;

comment on function public.begin_billing_automation_run(boolean) is
  'Atomically begins the singleton billing worker, or returns no row while a fresh run is active.';

notify pgrst, 'reload schema';
