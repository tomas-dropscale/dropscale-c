-- =============================================================================
-- 0069 — portal creative uploads: decouple from reporting role/binding.
--
-- After rollout changes, owns_ad_account() became reporting-scope aware for
-- normalized data (legacy_hybrid only or active reporting bindings). Creative
-- submissions are a client-provided upload flow and must remain available when
-- the user can open the workspace, regardless of reporting cutover state.
--
-- This migration narrows/rewrites only creative_submissions policies so a valid
-- workspace member can always submit/update/withdraw their store's creatives.
-- =============================================================================

drop policy if exists creative_submissions_select on public.creative_submissions;
create policy creative_submissions_select on public.creative_submissions
  for select using (
    (exists (
      select 1
      from public.ad_accounts account
      where account.id = ad_account_id
        and public.can_open_workspace(account.client_id)
    ))
    or public.is_admin()
  );

drop policy if exists creative_submissions_insert on public.creative_submissions;
create policy creative_submissions_insert on public.creative_submissions
  for insert with check (
    ((exists (
      select 1
      from public.ad_accounts account
      where account.id = ad_account_id
        and public.can_open_workspace(account.client_id)
    ) and status = 'new')
    or public.is_admin())
  );

drop policy if exists creative_submissions_update on public.creative_submissions;
create policy creative_submissions_update on public.creative_submissions
  for update using (
    (exists (
      select 1
      from public.ad_accounts account
      where account.id = ad_account_id
        and public.can_open_workspace(account.client_id)
    ) and status = 'new')
    or public.is_admin()
  )
  with check (
    (exists (
      select 1
      from public.ad_accounts account
      where account.id = ad_account_id
        and public.can_open_workspace(account.client_id)
    )
    )
    or public.is_admin()
  );

drop policy if exists creative_submissions_delete on public.creative_submissions;
create policy creative_submissions_delete on public.creative_submissions
  for delete using (
    ((exists (
      select 1
      from public.ad_accounts account
      where account.id = ad_account_id
        and public.can_open_workspace(account.client_id)
    ) and status = 'new')
    or public.is_admin())
  );
