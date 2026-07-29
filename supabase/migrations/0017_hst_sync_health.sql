-- =============================================================================
-- 0017 — remember WHY the last HST sync did not land.
--
-- The failure mode this closes: the pasted ERP session lasts about a day, the
-- self-renewal from the refresh token can fail (the ERP's /refresh-token is not
-- guaranteed to be the endpoint vue-pure-admin's mock uses), and from then on
-- every sync returns an error to whoever triggered it — which, on a page load,
-- is nobody. `last_synced_at` stayed frozen at the day the key was pasted and
-- the commission simply stopped appearing, with the reason living only in the
-- return value of a function no human was reading.
--
-- Two columns, one job: make the attempt itself a fact in the database, not an
-- event that vanishes.
--
--   last_attempt_at — every attempt, successful or not. Compared against
--                     last_synced_at, this is what separates "the cron is not
--                     running at all" from "the cron runs and HST refuses".
--   last_error      — the message, cleared on success. What the HST page shows
--                     instead of a silently stale number.
--
-- Deliberately NOT the token itself or any commission figure: this column ends
-- up on screen, and an error string is the only thing here that belongs there.
-- =============================================================================

alter table public.hst_integration
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text;
