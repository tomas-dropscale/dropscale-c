-- 0102: a client reads the frozen history of an account a handover retired
--
-- The portal's store projection (lib/portal/data.ts, through
-- lib/reporting/retired-sources.ts) keeps, under each Shopify anchor, every
-- Google account a handover or a retirement left without an active binding:
-- the store spent that money, so its history stays with the store. But the
-- member's session reads daily_metrics under owns_ad_account(), which since
-- 0055 admits a normalized account only while an ACTIVE binding exists. The
-- projection asked for the retired account's rows and RLS quietly answered
-- with none: the client's P&L and dashboard dropped that spend the day the
-- account moved, while the agency (is_admin) kept seeing it. Two readers of
-- the same store, two different numbers, and no error anywhere.
--
-- This grants the member the READ, and only the read, on the immutable
-- evidence the projection trusts: a revoked child binding of the member's own
-- client that a 'handed_over' event names as its prior binding, or that a
-- 'source_retired' event names as its binding. Row shape alone is not enough
-- - an abandoned staged source is revoked too, and its staging rows must never
-- reach a client-facing total - so the event is required. The grant is a
-- little wider than the projection's read: it does not follow the anchor
-- lineage, so a child retired under a store that was itself retired later is
-- readable too. The projection never asks for it, and it is the client's own.
--
-- owns_ad_account() itself is left untouched. It also gates writes (the legacy
-- recompute, the cost tables, creatives), and a retired account must stay
-- read-only for everyone; a second, additive SELECT policy widens nothing else.

create or replace function public.reads_retired_ad_account_history(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts account
    join public.client_reporting_bindings binding
      on binding.ad_account_id = account.id
     and binding.client_id = account.client_id
    where account.id = p_ad_account_id
      and public.is_client_member(account.client_id)
      and binding.status = 'revoked'
      and binding.shopify_connection_id is null
      and binding.shopify_anchor_binding_id is not null
      and exists (
        select 1
        from public.client_reporting_anchor_events event
        where (event.event_type = 'handed_over' and event.prior_binding_id = binding.id)
           or (event.event_type = 'source_retired' and event.binding_id = binding.id)
      )
  )
$$;

drop policy if exists daily_metrics_select_retired_history on public.daily_metrics;
create policy daily_metrics_select_retired_history on public.daily_metrics
  for select using (public.reads_retired_ad_account_history(ad_account_id));
