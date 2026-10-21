-- Automated reminders (2026-10-21): an unpaid checkout 30 minutes on, and a
-- signed-in customer's untouched cart an hour on. Both are scheduled as one
-- delayed Queue message each and checked once when it arrives — nothing polls.
--
-- wa_offers: the customer ticked "send me offers on WhatsApp". A WhatsApp that
-- names a coupon is a MARKETING message to Meta and needs that consent; without
-- it the unpaid reminder still goes as the plain utility template, and the cart
-- reminder goes by email only.
ALTER TABLE orders ADD COLUMN wa_offers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users  ADD COLUMN wa_offers INTEGER NOT NULL DEFAULT 0;

-- When the automatic unpaid reminder went (manual reminders use pay_reminder_at).
ALTER TABLE orders ADD COLUMN auto_reminder_at INTEGER;

-- When the last cart reminder went. At most one per customer every 3 days
-- (CART_COOLDOWN_MS), and the claim UPDATE on it stops a retry sending twice.
ALTER TABLE users ADD COLUMN cart_reminded_at INTEGER;

-- The /back/<token> link in a reminder: restores the cart in the browser and
-- opens checkout with COMEBACK filled in. A token per user, minted on first use.
-- unsub_token stops every reminder email with one click, no sign-in.
ALTER TABLE users ADD COLUMN back_token TEXT;
ALTER TABLE users ADD COLUMN reminders_off INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_back_token ON users(back_token) WHERE back_token IS NOT NULL;
