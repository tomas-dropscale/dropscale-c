-- =============================================================================
-- 0070 — creative submissions: evaluate the workspace check as a definer.
--
-- 0069 rewrote the creative_submissions policies with an inline EXISTS over
-- ad_accounts. Policy subqueries run under the *querying user's* RLS, and
-- ad_accounts_select_own (0055) only exposes legacy_hybrid rows to clients —
-- so every v2 client whose store row is a shopify_anchor got 42501 on INSERT
-- and an empty SELECT, breaking exactly the flow 0069 meant to protect.
--
-- Fix: move the check into a SECURITY DEFINER function (like
-- can_open_workspace itself), which sees ad_accounts without the caller's
-- RLS, and recreate the four policies on top of it. Status conditions are
-- unchanged from 0069.
-- =============================================================================

create or replace function public.can_use_creative_account(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts account
    where account.id = p_ad_account_id
      and public.can_open_workspace(account.client_id)
  );
$$;

drop policy if exists creative_submissions_select on public.creative_submissions;
create policy creative_submissions_select on public.creative_submissions
  for select using (
    public.can_use_creative_account(ad_account_id)
    or public.is_admin()
  );

drop policy if exists creative_submissions_insert on public.creative_submissions;
create policy creative_submissions_insert on public.creative_submissions
  for insert with check (
    (public.can_use_creative_account(ad_account_id) and status = 'new')
    or public.is_admin()
  );

drop policy if exists creative_submissions_update on public.creative_submissions;
create policy creative_submissions_update on public.creative_submissions
  for update using (
    (public.can_use_creative_account(ad_account_id) and status = 'new')
    or public.is_admin()
  )
  with check (
    public.can_use_creative_account(ad_account_id)
    or public.is_admin()
  );

drop policy if exists creative_submissions_delete on public.creative_submissions;
create policy creative_submissions_delete on public.creative_submissions
  for delete using (
    (public.can_use_creative_account(ad_account_id) and status = 'new')
    or public.is_admin()
  );
