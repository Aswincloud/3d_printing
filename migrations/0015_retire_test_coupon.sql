-- 0015_retire_test_coupon.sql — deactivate the 100%-off TEST coupon and clear out
-- expired chat codes.
--
-- ── TEST ─────────────────────────────────────────────────────────────────────
--
-- code=TEST, percent, value=100, active=1, expires_at=NULL, min_order_paise=0,
-- max_discount_paise=NULL. A hundred percent off anything, forever, with no floor
-- and no cap.
--
-- It is not currently exploitable: uses=1 of max_uses=1, and I confirmed against
-- production that /api/coupon/check answers "That promo code has been fully
-- claimed." So this is not an open hole today.
--
-- It is one edit away from being one. max_uses is editable from the coupons
-- dashboard, and "TEST" is exactly the kind of row someone bumps to 2 to re-test
-- something and forgets. The guess is also free: TEST is the first code anyone
-- tries, and /api/coupon/check tells them whether a code is real. RL_COUPON caps
-- that at 15/min, which stops enumeration but not someone typing four letters.
--
-- Deactivating costs nothing — a real test coupon can be recreated in the
-- dashboard in seconds, and should be created with an expiry and a discount that
-- is not 100%.
--
-- Deactivated rather than deleted so the row that redeemed it keeps a coupon to
-- point at. AP-63bdd196 is cancelled, but orders reference coupon_code and a
-- dangling code in an order record is worse than an inactive row.
--
-- ── expired chat codes ───────────────────────────────────────────────────────
--
-- 27 CHAT-XXXXXX rows from the 6 Aug testing, all active=1, all expired four days
-- ago. Expiry IS enforced at check time — confirmed against production, an expired
-- code answers "That promo code has expired" — so these are inert, not a hole.
--
-- They are deactivated because active=1 on 27 dead rows makes the dashboard's
-- coupon list useless for seeing what is actually live, and because the next
-- person to audit this has to re-derive that expiry beats active all over again.
-- issueChatCoupon mints these continuously in normal operation, so without a
-- sweep this list only grows.
--
-- Not deleted, for the same reason as TEST: an order may reference the code.

UPDATE coupons SET active = 0, updated_at = 1786100000000
WHERE code = 'TEST';

-- Expired chat codes only. Guards on BOTH conditions rather than the prefix alone:
-- a live, unexpired code issued to a visitor mid-conversation must not be killed
-- by a cleanup pass. expires_at is not null for every chat code by construction
-- (CHAT_COUPON_TTL is always set), but the null check is there so a future code
-- without an expiry is never swept up by accident.
UPDATE coupons SET active = 0, updated_at = 1786100000000
WHERE code LIKE 'CHAT-%'
  AND active = 1
  AND expires_at IS NOT NULL
  AND expires_at < 1786100000000;
