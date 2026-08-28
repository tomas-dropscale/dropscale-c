-- =============================================================================
-- 0088 - A session that can rebuild itself.
--
-- Connecting HST means pasting a login response copied out of the browser's
-- network tab. It works, and it has failed twice in the way that matters: the
-- refresh token eventually expires too, and when it does the supplier's costs
-- and commission stop arriving with nothing on screen looking any different
-- from a supplier who reported nothing. The session died on 2026-08-02 and was
-- noticed weeks later.
--
-- Storing the credentials lets ensureFreshToken fall back to logging in again
-- instead of giving up, which is what makes the integration unattended rather
-- than merely automatic-until-it-isn't.
--
-- Encrypted with the same AES-GCM key as every other secret here, and readable
-- only by the server: hst_integration is already admin-only under RLS and no
-- read path returns these columns to a page.
-- =============================================================================

alter table public.hst_integration
  add column if not exists username_enc text,
  add column if not exists password_enc text;

-- Both or neither. A username with no password cannot log in, and would leave
-- the fallback looking available while never working.
alter table public.hst_integration
  drop constraint if exists hst_integration_credentials_shape;
alter table public.hst_integration
  add constraint hst_integration_credentials_shape check (
    (username_enc is null and password_enc is null)
    or (username_enc is not null and password_enc is not null)
  );
