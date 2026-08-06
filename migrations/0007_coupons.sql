-- 0007_coupons.sql — promo codes
--
-- Follows the conventions in 0001: IF NOT EXISTS, TEXT PRIMARY KEY holding a
-- uuid, money as INTEGER paise, timestamps as INTEGER epoch-ms supplied by the
-- app, indexes named idx_<table>_<cols>.
--
-- This is the first feature that REDUCES what a customer pays. Everything until
-- now only computed a price upward from D1, and priceCart() calls itself "the
-- whole security model" for that reason. So the rule is the same one that
-- applies to prices: the client sends a CODE, and every number attached to that
-- code is read from here. A `discount_paise` in a request body is ignored
-- exactly as `price_paise` already is.

CREATE TABLE IF NOT EXISTS coupons (
  id            TEXT PRIMARY KEY,        -- uuid
  -- COLLATE NOCASE so save10 and SAVE10 are one coupon, the same reason
  -- users.email and otp_codes.email use it. Customers retype codes from
  -- Instagram captions and get the case wrong.
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind          TEXT NOT NULL,           -- 'percent' | 'fixed' | 'shipping'
  -- percent: 1-100. fixed: paise off. shipping: unused, always 0.
  value         INTEGER NOT NULL,
  min_order_paise    INTEGER NOT NULL DEFAULT 0,
  -- Caps what a percentage code can take off, so "50% off" on a ₹12,000 order
  -- doesn't cost ₹6,000. NULL = uncapped. Meaningless for the other kinds.
  max_discount_paise INTEGER,
  expires_at    INTEGER,                 -- epoch ms; NULL = never expires
  max_uses      INTEGER,                 -- NULL = unlimited
  -- Incremented when an order is PAID, not when it is created — see the note on
  -- coupon_redemptions below.
  uses          INTEGER NOT NULL DEFAULT 0,
  once_per_customer INTEGER NOT NULL DEFAULT 0,
  -- A kill switch that keeps the row. Deleting a coupon someone has already
  -- redeemed would orphan the redemption history; flipping this stops it being
  -- accepted while leaving the record intact.
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active, code);

-- Who redeemed what.
--
-- Identity is the EMAIL, not the user id: checkout works without an account, and
-- refusing a guest a code at the payment step is the worst possible place in the
-- funnel to introduce a sign-in. The accepted trade is that someone with two
-- email addresses gets two uses of a once-per-customer code. `user_id` is
-- recorded when the buyer happened to be signed in, for audit only — it is never
-- the thing checked.
--
-- Rows are written when the order is PAID. Checked the live data before
-- deciding: most orders never reach 'paid' (abandoned checkouts, cancelled
-- payments). Counting at order-creation time would let people who opened
-- checkout and closed it burn through a 50-use launch code without anyone
-- buying anything.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id         TEXT PRIMARY KEY,           -- uuid
  coupon_id  TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  email      TEXT NOT NULL COLLATE NOCASE,
  user_id    TEXT,                       -- when signed in; audit only
  created_at INTEGER NOT NULL
);

-- One redemption per order, enforced by the database rather than by remembering
-- to check. This is what makes a redelivered webhook safe: the second INSERT
-- fails on the constraint instead of double-counting a use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_order ON coupon_redemptions(order_id);

-- The once-per-customer lookup: "has this email used this coupon before?"
CREATE INDEX IF NOT EXISTS idx_redemption_lookup ON coupon_redemptions(coupon_id, email);

-- Snapshot the discount onto the order.
--
-- Same reasoning as order_items snapshotting name and price_paise rather than
-- joining back to products: a receipt reprinted months later must show what was
-- actually charged, even if the coupon has since been edited, deactivated or
-- deleted. Without this, changing SAVE10 to 20% would silently rewrite history.
--
-- discount_paise defaults to 0, so every existing order stays arithmetically
-- consistent: subtotal - discount + shipping = total holds for rows written
-- before this migration.
ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE orders ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
