-- 0003_accounts.sql — customer accounts, passwordless login, server-side cart.
--
-- @aswincloud/auth ships a schema.sql with users / oauth_identities / otp_codes,
-- but it is NOT applied wholesale here:
--
--   * its `users.created_at` is epoch SECONDS, while every table in this
--     database is epoch ms (see 0001_init.sql's header),
--   * its `password_hash` is NOT NULL with no default, which is meaningless for
--     a passwordless site and would have to be filled with a sentinel,
--   * `oauth_identities` is unused — customers sign in by email code only.
--
-- `otp_codes` IS taken verbatim, because the package's own SQL reads and writes
-- that table and must keep matching.

-- Customers. One row per email that has ever signed in.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,                     -- uuid
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- NOCASE: 'A@b.com' and 'a@b.com' are one account
  name       TEXT,
  created_at INTEGER NOT NULL,                     -- epoch ms
  last_seen  INTEGER
);

-- Verbatim from node_modules/@aswincloud/auth/schema.sql so upsertOtp/getOtp/
-- incrementOtpAttempts/deleteOtp work unmodified.
--
-- NOTE: expires_at here is epoch SECONDS. The package's own comment says "epoch
-- ms" and is wrong — flows.js writes nowSec()+ttl and compares against nowSec().
-- Only package code touches this column, so leave the convention alone rather
-- than "fixing" it into an inconsistency.
CREATE TABLE IF NOT EXISTS otp_codes (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash  TEXT NOT NULL,                        -- sha256(code|pepper), never the code itself
  expires_at INTEGER NOT NULL,                     -- epoch SECONDS (package convention)
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Per-email send throttle for the OTP endpoint.
--
-- POST /api/auth/code is unauthenticated and sends email, so without this it's
-- an email bomb aimed at any address plus a way to burn the Resend quota.
-- invoicer's equivalent endpoint has no throttle at all; this is the fix, not a
-- port.
CREATE TABLE IF NOT EXISTS otp_requests (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL                    -- epoch ms
);

-- Server-side cart, so it follows a signed-in customer between devices.
--
-- Stores ONLY product_id and qty — no price, no name. Same rule as the
-- localStorage cart it replaces: a tampered cart can change what you SEE, never
-- what you PAY, because priceCart() reads prices from `products`.
--
-- The (user_id, product_id) primary key gives us for free the de-duplication
-- that readCart() does by hand in the browser.
CREATE TABLE IF NOT EXISTS cart_items (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

-- Link orders to accounts.
--
-- Nullable on purpose: guest checkout stays supported, and every order placed
-- before today has no account to point at. On first sign-in we claim the guest
-- orders matching that verified email.
ALTER TABLE orders ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
