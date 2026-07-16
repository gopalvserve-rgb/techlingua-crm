-- =============================================================================
-- 028 — SETTINGS: complete credential entry + WhatsApp Embedded Signup.
--
-- Almost nothing is needed here, and that is the point: `channel_config.channel`
-- was deliberately left an UNCONSTRAINED VARCHAR in 026 ("a new channel is one
-- entry in messaging/providers.ts, NOT a migration"). Google Calendar (`calendar`)
-- and Cloudflare (`storage`) are therefore pure registry additions — zero DDL —
-- and so are the WhatsApp Embedded Signup fields, which are keys in the existing
-- `config` JSONB.
--
-- What DOES need a migration is a SECURITY FIX found while auditing this screen:
--
--   `calendar_sync` (Sprint 3) kept the OAuth CLIENT SECRET and the REFRESH TOKEN
--   in the plain `app_setting.value` JSONB — unencrypted, and readable by anyone
--   holding settings.read. Every other credential in this product is AES-256-GCM
--   at rest and masked on read. This moves it into that same store.
--
-- Idempotent throughout: re-running is a no-op.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) calendar_sync -> channel_config('calendar')
--
-- Only the NON-secret half is carried. The client id is not a secret; the client
-- SECRET is deliberately NOT copied, because this migration has no access to the
-- encryption key (SECRETS_KEY lives in the app process, not in Postgres) — and
-- writing it here in clear would recreate the exact problem being fixed.
--
-- Nothing is lost in practice: the client has never supplied calendar credentials
-- (PROJECT_STATUS §4.2c — asked 14 Jul, still outstanding), so on the live DB this
-- selects zero rows. If a secret DID exist, the row lands as "not configured",
-- naming the client secret as missing, and he pastes it once into a field that
-- encrypts it. Making him re-enter a credential is strictly better than silently
-- keeping a plaintext copy of it.
-- ---------------------------------------------------------------------------
INSERT INTO channel_config (org_id, channel, provider, vertical_id, config, secrets, is_active)
SELECT
  (SELECT id FROM organisation ORDER BY id LIMIT 1),
  'calendar',
  CASE WHEN s.value->>'provider' = 'outlook' THEN 'outlook_oauth' ELSE 'google_oauth' END,
  NULL,
  jsonb_strip_nulls(jsonb_build_object('client_id', s.value->>'client_id')),
  '{}'::jsonb,
  TRUE
FROM app_setting s
WHERE s.key = 'calendar_sync'
  AND COALESCE(s.value->>'provider', '') <> ''
  AND EXISTS (SELECT 1 FROM organisation)
  AND NOT EXISTS (
    SELECT 1 FROM channel_config c
     WHERE c.channel = 'calendar' AND c.vertical_id IS NULL AND c.deleted_at IS NULL
  );

-- ---------------------------------------------------------------------------
-- 2) Retire the plaintext row. This both DELETES the exposed secret and removes
--    the second place the credential could be edited — the Sprint-3 rule stands:
--    two places to edit one credential is how you end up with two different
--    credentials. Calendar sync is now Settings › Channels › Calendar, encrypted.
--
--    Re-running finds no row and deletes nothing.
--
--    NOTE: `sms_provider` is deliberately left alone. It is likewise superseded,
--    but `auth/sms.provider.ts` still reads it as a documented back-compat step in
--    its resolution chain — removing the row is a separate decision, not a
--    drive-by in a settings migration.
-- ---------------------------------------------------------------------------
DELETE FROM app_setting WHERE key = 'calendar_sync';
