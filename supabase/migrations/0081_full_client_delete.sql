-- Owner decision (2026-08-19): "Remove client" is a FULL DELETE — the client
-- and every row of theirs leaves the platform (Stripe keeps its own immutable
-- invoice records; nothing legal is lost there).
--
-- Mechanics: the platform is covered in immutability guards (invoices,
-- bindings, billing starts/ends, cutover markers, append-only referral and
-- event tables). Patching an offboarding escape into ~18 guard functions
-- would be sprawling and fragile, so this purpose-bound RPC instead runs the
-- explicit purge with session_replication_role = replica (user AND FK
-- triggers off, transaction-local), then restores normal enforcement and
-- deletes auth.users — whose active CASCADE to portal_clients acts as the
-- final integrity proof: any client-scoped row this purge missed still
-- RESTRICTs that delete and aborts the whole transaction.

create or replace function public.delete_portal_client_completely(
  p_client_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can remove a client.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_client_id is null or not exists (
    select 1 from public.portal_clients where id = p_client_id for update
  ) then
    raise exception 'Client profile not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.profiles where id = p_client_id and role = 'admin') then
    raise exception 'Admin profiles cannot be removed as clients.' using errcode = '42501';
  end if;

  set local session_replication_role = 'replica';

  -- Queue/operational state
  delete from public.billing_automation_items where client_id = p_client_id;
  delete from public.billing_issue_leases where client_id = p_client_id;
  delete from public.billing_cycle_skips where client_id = p_client_id;
  delete from public.campaign_action_policies policy
    where exists (
      select 1 from public.client_reporting_bindings binding
      where binding.id = policy.client_reporting_binding_id
        and binding.client_id = p_client_id
    );
  delete from public.campaign_action_operations where client_id = p_client_id;

  -- Invoices and their satellites (Stripe keeps the remote records)
  delete from public.historical_billing_rollover_issuances issuance
    where exists (
      select 1 from public.invoices invoice
      where invoice.id = issuance.invoice_id and invoice.client_id = p_client_id
    );
  delete from public.invoice_referral_events event
    where exists (
      select 1 from public.invoices invoice
      where invoice.id = event.invoice_id and invoice.client_id = p_client_id
    );
  delete from public.invoice_commission_rows claim
    where exists (
      select 1 from public.invoices invoice
      where invoice.id = claim.invoice_id and invoice.client_id = p_client_id
    );
  delete from public.invoices where client_id = p_client_id;

  -- Referral structures touching this client, on either side. Removing a
  -- grant someone earned for referring this client changes that referrer's
  -- future pricing — accepted: the referred client no longer exists.
  delete from public.referral_discount_term_items item
    where item.referred_client_id = p_client_id
       or exists (
         select 1 from public.referral_discount_terms term
         where term.id = item.term_id
           and (term.client_id = p_client_id
                or term.decision_referred_client_id = p_client_id)
       );
  delete from public.referral_discount_terms
    where client_id = p_client_id or decision_referred_client_id = p_client_id;
  delete from public.referral_attribution_events
    where referrer_client_id = p_client_id or referred_client_id = p_client_id;
  delete from public.referral_claim_requests
    where referrer_client_id = p_client_id or referred_client_id = p_client_id;
  update public.portal_clients set referred_by = null where referred_by = p_client_id;

  -- Billing evidence and metrics, per ad account
  delete from public.google_ledger_sync_windows sync_window
    where exists (
      select 1 from public.ad_accounts account
      where account.id = sync_window.ad_account_id and account.client_id = p_client_id
    );
  delete from public.commissions ledger
    where exists (
      select 1 from public.ad_accounts account
      where account.id = ledger.ad_account_id and account.client_id = p_client_id
    );
  delete from public.historical_billing_rollover_rows rollover_row
    where exists (
      select 1 from public.ad_accounts account
      where account.id = rollover_row.ad_account_id and account.client_id = p_client_id
    );
  delete from public.historical_billing_rollover_account_proofs proof
    where exists (
      select 1 from public.ad_accounts account
      where account.id = proof.ad_account_id and account.client_id = p_client_id
    );
  delete from public.historical_billing_rollover_blockers where client_id = p_client_id;
  delete from public.historical_billing_rollovers where client_id = p_client_id;
  delete from public.ad_account_billing_ends billing_end
    where exists (
      select 1 from public.ad_accounts account
      where account.id = billing_end.ad_account_id and account.client_id = p_client_id
    );
  delete from public.ad_account_billing_starts billing_start
    where exists (
      select 1 from public.ad_accounts account
      where account.id = billing_start.ad_account_id and account.client_id = p_client_id
    );
  delete from public.reviewed_full_day_billing_boundaries where client_id = p_client_id;
  delete from public.ad_account_commission_terms term
    where exists (
      select 1 from public.ad_accounts account
      where account.id = term.ad_account_id and account.client_id = p_client_id
    );

  -- Reporting machine: events, states, mappings, bindings
  delete from public.client_google_ads_reporting_metadata_events where client_id = p_client_id;
  delete from public.client_reporting_binding_events event
    where exists (
      select 1 from public.client_reporting_bindings binding
      where binding.id = event.binding_id and binding.client_id = p_client_id
    );
  delete from public.client_reporting_anchor_events event
    where exists (
      select 1 from public.ad_accounts account
      where account.id = event.ad_account_id and account.client_id = p_client_id
    );
  delete from public.client_reporting_sync_states state
    where exists (
      select 1 from public.client_reporting_bindings binding
      where binding.id = state.binding_id and binding.client_id = p_client_id
    );
  delete from public.client_asset_mappings mapping
    where exists (
      select 1 from public.client_onboarding_sessions session
      where session.id = mapping.session_id
        and (session.target_client_id = p_client_id
             or session.claimed_user_id = p_client_id)
    );
  delete from public.client_reporting_bindings where client_id = p_client_id;
  delete from public.client_rollout_states where client_id = p_client_id;

  -- Store data cascaded from accounts, made explicit under replica mode
  delete from public.admin_reporting_range_snapshots snapshot
    where exists (
      select 1 from public.ad_accounts account
      where account.id = snapshot.scope_account_id and account.client_id = p_client_id
    );
  delete from public.daily_metrics metric
    where exists (
      select 1 from public.ad_accounts account
      where account.id = metric.ad_account_id and account.client_id = p_client_id
    );
  delete from public.campaigns campaign
    where exists (
      select 1 from public.ad_accounts account
      where account.id = campaign.ad_account_id and account.client_id = p_client_id
    );
  delete from public.cogs_collections collection
    where exists (
      select 1 from public.ad_accounts account
      where account.id = collection.ad_account_id and account.client_id = p_client_id
    );
  delete from public.store_products product
    where exists (
      select 1 from public.ad_accounts account
      where account.id = product.ad_account_id and account.client_id = p_client_id
    );
  delete from public.creative_deliveries delivery
    where exists (
      select 1 from public.ad_accounts account
      where account.id = delivery.ad_account_id and account.client_id = p_client_id
    );
  delete from public.creative_submissions submission
    where exists (
      select 1 from public.ad_accounts account
      where account.id = submission.ad_account_id and account.client_id = p_client_id
    );
  update public.creative_submissions set submitted_by = null where submitted_by = p_client_id;
  delete from public.ad_accounts where client_id = p_client_id;

  -- Onboarding: connections, secrets, events, sessions
  delete from public.client_shopify_credentials credential
    where exists (
      select 1 from public.client_shopify_connections connection
      where connection.id = credential.connection_id and connection.client_id = p_client_id
    );
  delete from public.client_shopify_connections where client_id = p_client_id;
  delete from public.client_google_ads_connections where client_id = p_client_id;
  delete from public.client_onboarding_secrets secret
    where exists (
      select 1 from public.client_onboarding_sessions session
      where session.id = secret.session_id
        and (session.target_client_id = p_client_id
             or session.claimed_user_id = p_client_id)
    );
  delete from public.client_onboarding_events event
    where exists (
      select 1 from public.client_onboarding_sessions session
      where session.id = event.session_id
        and (session.target_client_id = p_client_id
             or session.claimed_user_id = p_client_id)
    );
  delete from public.client_onboarding_sessions
    where target_client_id = p_client_id or claimed_user_id = p_client_id;

  -- Client-scoped leftovers
  delete from public.account_requests where client_id = p_client_id;
  delete from public.billing_profiles where client_id = p_client_id;
  delete from public.client_invites where client_id = p_client_id;
  update public.client_invites set invited_by = null where invited_by = p_client_id;
  update public.client_invites set accepted_by = null where accepted_by = p_client_id;
  delete from public.client_members where client_id = p_client_id or member_id = p_client_id;
  update public.client_members set invited_by = null where invited_by = p_client_id;

  -- Restore enforcement, then let the auth cascade prove the purge complete:
  -- portal_clients and profiles fall via auth.users' active CASCADE, and any
  -- surviving reference to this client RESTRICTs and aborts everything.
  set local session_replication_role = 'origin';
  delete from auth.users where id = p_client_id;

  if exists (select 1 from public.portal_clients where id = p_client_id) then
    raise exception 'The client row survived its own deletion.' using errcode = '22023';
  end if;

  return p_client_id;
end
$$;
