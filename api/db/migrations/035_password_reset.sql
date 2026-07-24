-- =============================================================================
-- 035 — PASSWORD RESET (Forgot password / reset flow)
--
-- The client tested "forgot password" and received nothing, because the feature
-- did not exist. This adds the ONE table it needs. The rest of the flow reuses
-- what is already here:
--   * the email goes out through the Sprint-4 per-vertical/system SMTP send path
--     (channel_config + MessagingService) — no new mailer;
--   * secrets/crypto reuse common/crypto.util.ts;
--   * the endpoints are @Public, like login/OTP.
--
-- SECURITY MODEL
--   * We store ONLY a SHA-256 HASH of the reset token (token_hash), never the
--     token itself — a leaked DB row cannot be turned back into a working link.
--   * Single-use: used_at is stamped the moment a token is spent, and a
--     successful reset marks every OTHER outstanding token for that user used.
--   * Time-limited: expires_at (30 minutes, set by the app).
--   * Enumeration-safe: the request endpoint always answers the same generic
--     200 whether or not the email belongs to an account, exactly as the OTP
--     flow was hardened (see auth/otp.service.ts).
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes), auto-run on
-- boot by the migration runner (src/database/migrate.ts), one file, once.
-- =============================================================================

CREATE TABLE IF NOT EXISTS password_reset (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT REFERENCES organisation(id),
  user_id     BIGINT NOT NULL REFERENCES "user"(id),
  -- SHA-256 hex of the URL-safe random token. The plaintext is emailed once and
  -- is never stored or retrievable.
  token_hash  VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  request_ip  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The token hash is the lookup key on /auth/reset-password; unique so a hash can
-- never collide and vouch for two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS ux_password_reset_token_hash ON password_reset (token_hash);
CREATE INDEX IF NOT EXISTS ix_password_reset_user ON password_reset (user_id, created_at DESC);
