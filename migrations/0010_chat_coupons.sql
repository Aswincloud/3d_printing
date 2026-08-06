-- Codes issued by the chat bot.
--
-- These are ordinary rows in `coupons` — same kinds, same limits, same
-- applyCoupon() path, so nothing about redemption, expiry or the admin UI needs
-- to learn a new concept. Two columns are all that is added.

-- Who the code was minted for: the Chatwoot CONTACT id, not the conversation id.
-- A visitor who opens three conversations is one contact and must get one code,
-- otherwise "any discount?" in a fresh chat window mints a fresh code every time.
--
-- Nullable, because every coupon Aswin creates by hand has no visitor. NULL here
-- means "not issued to anyone in particular", which is the normal case.
ALTER TABLE coupons ADD COLUMN issued_to TEXT;

-- Where it came from ('chat'), so the admin list can tell an auto-minted code
-- from one Aswin typed, and so the hourly mint cap has something to count that
-- cannot be confused with a hand-made code that happens to start with CHAT-.
ALTER TABLE coupons ADD COLUMN issued_by TEXT;

-- The lookup on the hot path: "does this visitor already have a live code?".
-- Partial index — the vast majority of rows have issued_to NULL and indexing
-- those would be dead weight.
CREATE INDEX IF NOT EXISTS idx_coupons_issued_to
  ON coupons(issued_to, expires_at) WHERE issued_to IS NOT NULL;

-- The hourly mint cap counts by source and time.
CREATE INDEX IF NOT EXISTS idx_coupons_issued_by
  ON coupons(issued_by, created_at) WHERE issued_by IS NOT NULL;
