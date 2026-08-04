-- 0004_oauth_identities.sql — link social logins to customer accounts.
--
-- 0003 deliberately skipped this table because customers signed in by emailed
-- code only. Now that Google/GitHub/Microsoft are offered too, an identity has
-- to be linkable to a users row.
--
-- Taken verbatim from node_modules/@aswincloud/auth/schema.sql so the package's
-- getUserByOAuthIdentity / linkOAuthIdentity work unmodified.
--
-- The primary key is (provider, provider_user_id), NOT the email, and that
-- choice matters: the provider's user id is stable, an email is not. Link on
-- email and a customer who changes their Google address is orphaned from their
-- own order history. The package's own comment says the same thing:
--
--   "multi-user sites should link accounts on (provider, providerUserId) so a
--    provider email change doesn't orphan the account"
--
-- `email` is stored too, but only as a record of what the provider asserted at
-- link time — it is never the lookup key.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider         TEXT NOT NULL,                        -- 'google' | 'github' | 'microsoft'
  provider_user_id TEXT NOT NULL,                        -- the provider's stable id
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT,                                 -- as asserted at link time
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);
