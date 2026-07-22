-- =============================================================================
-- Dropscale IO — per-client Google Ads connection
--
-- The client authorises their own Google Ads account from inside the portal
-- ("Connect Google Ads"), so each ad_account carries its OWN OAuth refresh
-- token — not a single agency token. That is the whole difference from the
-- MCC model.
--
-- The refresh token is stored ENCRYPTED (AES-GCM, key in GOOGLE_ADS_TOKEN_ENC_KEY,
-- server-only). The database never holds plaintext, and the key never leaves
-- the server, so even a full table read yields nothing usable.
-- =============================================================================

alter table public.ad_accounts
  -- AES-GCM ciphertext (base64: iv + tag + data). Never plaintext.
  add column if not exists google_ads_refresh_token text,
  -- Which Google account authorised, shown back to the client for confidence.
  add column if not exists google_ads_connected_email text,
  -- Cheap boolean so the UI and list selects don't have to touch the token.
  add column if not exists google_ads_connected boolean not null default false;

-- No new policies: a client already updates their own ad_accounts row
-- (ad_accounts_update_own, migrations 0001/0002), which is exactly the
-- connect and disconnect action. The status/client_id guard trigger still
-- blocks the columns that must stay team-controlled.
--
-- The token column is readable by the owner under that same policy, but it is
-- only ever ciphertext, and the portal's list/detail selects exclude it so it
-- is never shipped to the browser in normal flows.
