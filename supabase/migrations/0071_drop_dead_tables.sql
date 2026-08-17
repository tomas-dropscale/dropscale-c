-- =============================================================================
-- 0071 — drop dead structures (owner-approved cleanup, 2026-08-17).
--
-- All of these had zero readers or writers in the deployed application:
--   · boards/board_columns/cards/card_assignees/card_comments — July kanban
--     prototype, last touched 2026-07-23, no .from() anywhere;
--   · app_secrets + set_app_secret() — stub nothing ever called;
--   · research_comparisons — one-off scratch row;
--   · client_google_ads_reporting_identity_events — write-once leftover of
--     migration 0055, no function or code references it;
--   · clients — the legacy CRM roster. portal_clients is the real roster;
--     this table never held a row in production. The two dead reads were
--     removed from the app in the same change; commissions.client_id and
--     portal_clients.crm_client_id stay as always-null columns so historical
--     row shapes and inserts keep working, but their FKs go with the table.
--
-- Row backups: audits/backups/cirurgia-2026-08-17-stale.json (local, untracked).
-- =============================================================================

drop table if exists public.card_comments;
drop table if exists public.card_assignees;
drop table if exists public.cards;
drop table if exists public.board_columns;
drop table if exists public.boards;
drop function if exists public.move_card(uuid, uuid, integer);

drop function if exists public.set_app_secret(text, text, text, uuid);
drop table if exists public.app_secrets;

drop table if exists public.research_comparisons;
drop table if exists public.client_google_ads_reporting_identity_events;

alter table public.commissions
  drop constraint if exists commissions_client_id_fkey;
alter table public.portal_clients
  drop constraint if exists portal_clients_crm_client_id_fkey;
drop table if exists public.clients;
