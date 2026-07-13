-- 012 — Client update #1: MOBILE-FIRST users & auth.
-- user.phone becomes mandatory + unique (login identifier); email becomes optional
-- (kept unique when present — Postgres UNIQUE ignores NULLs). Existing/seeded users
-- without a phone are backfilled with deterministic unique placeholders
-- (+9190000<id padded to 5>) so the constraint can be applied idempotently.
-- Also creates auth_otp (bcrypt-hashed one-time codes: 5-min expiry, 3 attempts,
-- 60s resend throttle enforced in the API) and app_setting (SMS provider config
-- read by the pluggable SMS abstraction — none configured => 503 on OTP request).

-- 1) normalise already-stored user phones to the canonical form (function from 009)
UPDATE "user" SET phone = phone_canonical(phone), updated_at = now()
 WHERE phone IS NOT NULL AND phone IS DISTINCT FROM phone_canonical(phone);

-- 2) de-duplicate: keep the lowest id on a phone, later holders get a placeholder
UPDATE "user" u SET phone = '+9190000' || lpad(u.id::text, 5, '0'), updated_at = now()
 WHERE u.phone IS NOT NULL
   AND EXISTS (SELECT 1 FROM "user" v WHERE v.phone = u.phone AND v.id < u.id);

-- 3) backfill missing phones with deterministic unique placeholders
UPDATE "user" SET phone = '+9190000' || lpad(id::text, 5, '0'), updated_at = now()
 WHERE phone IS NULL OR btrim(phone) = '';

-- 4) constraints (idempotent)
ALTER TABLE "user" ALTER COLUMN phone SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_phone ON "user"(phone);
ALTER TABLE "user" ALTER COLUMN email DROP NOT NULL;

-- 5) OTP login codes (hashed, short-lived)
CREATE TABLE IF NOT EXISTS auth_otp (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  phone       VARCHAR(20) NOT NULL,
  code_hash   VARCHAR(100) NOT NULL,          -- bcrypt of the 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL,           -- created_at + 5 minutes
  attempts    INT NOT NULL DEFAULT 0,         -- verify attempts (max 3)
  consumed_at TIMESTAMPTZ,                    -- set on successful verify
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_otp_phone ON auth_otp(phone, created_at DESC);

-- 6) org-level settings key/value store (SMS gateway config lands here)
CREATE TABLE IF NOT EXISTS app_setting (
  key        VARCHAR(100) PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT
);
