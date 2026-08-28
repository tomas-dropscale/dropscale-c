-- =============================================================================
-- 0089 - Each client's own HST login.
--
-- 0088 stored ONE HST session for the whole platform, which is right for the
-- commission: HST pays the agency, and the agency reads its own statement.
-- It is wrong for costs. A client's supplier account is theirs, it sees their
-- shop and no one else's, and there is exactly one row to put it in — so the
-- first client to connect would overwrite the agency's session, and from that
-- moment every other client's costs would be pulled with this client's token.
-- Both directions of that are a cross-tenant leak.
--
-- One row per client, therefore, and the two things stay apart: hst_integration
-- remains the agency's commission session, and this table is where a client's
-- own credentials live.
-- =============================================================================

create table if not exists public.client_hst_credentials (
  client_id uuid primary key references public.portal_clients (id) on delete cascade,
  -- AES-GCM, same key as every other secret here. Kept so an expired refresh
  -- token means "sign in again" rather than "the costs stopped and nobody
  -- noticed" — the failure that killed the agency's own session for weeks.
  username_enc text not null,
  password_enc text not null,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  -- Why the last attempt failed, cleared on success. Without it a wrong
  -- password and a supplier with nothing to report look identical.
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_hst_credentials enable row level security;

-- Deliberately NO policies.
--
-- RLS with no policy denies everyone, which is the point: not the owning
-- client, not a sócio, not an admin. Only the service role reaches this table,
-- and it does so from server code that decrypts, uses and discards.
--
-- A client does need to know whether they are connected and what went wrong.
-- That is a boolean and a message, served by the server from these columns —
-- and nothing about a stored credential has to travel to a browser for it. A
-- select policy here would put ciphertext in reach of PostgREST for no gain.
