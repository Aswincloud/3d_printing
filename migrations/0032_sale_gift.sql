-- A free gift with a sale (2026-11-01): "order above ₹999 and get a free 3D-printed
-- surprise gift" for DIWALI26. Lives on the coupon, so it runs exactly as long
-- as the sale and ends with it.
--
-- gift_min_paise: what the customer PAYS (after discount, shipping included) must
--                 be at least this. NULL = the sale has no gift.
-- gift_text:      what they get ("a free 3D-printed surprise gift").
-- orders.gift:    the gift an order earned, snapshotted when it is placed, so
--                 the owner knows which parcels to put one in.
ALTER TABLE coupons ADD COLUMN gift_min_paise INTEGER;
ALTER TABLE coupons ADD COLUMN gift_text TEXT;
ALTER TABLE orders  ADD COLUMN gift TEXT;
