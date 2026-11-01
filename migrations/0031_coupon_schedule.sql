-- Seasonal sales on a calendar (2026-11-01): DIWALI26 in November, NEWYEAR27 in
-- December, PONGAL27 in January — each live only for its own month, switching
-- on and off by date with nobody touching anything.
--
-- starts_at: epoch ms before which the code is not usable at checkout (NULL =
-- usable from creation, as every coupon before this was).
-- occasion:  a short label ("🪔 Diwali deals"). A coupon with one is a SALE:
--            it is featured in the banner / homepage offer while live, and listed
--            under "Offers" in the menu while live or upcoming. A coupon without
--            one (WELCOME10, COMEBACK, chat codes) is never shown there.
ALTER TABLE coupons ADD COLUMN starts_at INTEGER;
ALTER TABLE coupons ADD COLUMN occasion TEXT;
