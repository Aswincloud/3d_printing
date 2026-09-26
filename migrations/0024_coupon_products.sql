-- Which products a promo code applies to. No rows = the code applies to the
-- whole cart, which is every existing code's behaviour and stays the default.
--
-- Asked for on 2026-09-26: "restrict a coupon code for only specific products".
-- The first attempt at a single-product deal (OFFER250) had to lean on a
-- minimum-order amount equal to the product's price, which only works while
-- nothing else in the shop costs the same or more. This is the real thing.
--
-- The rule lives in applyCoupon(): a scoped code is computed on the ELIGIBLE
-- items' subtotal only — percent of them, fixed capped at them, free shipping
-- when at least one is in the cart — and a cart with none of them is refused
-- with the product names, not a silent zero. The minimum-order check stays on
-- the whole order; that is what "minimum order" means.
--
-- Cascades both ways: deleting the coupon removes its scope, and a product that
-- is deleted drops out of every code it was on. The same REFERENCES … ON DELETE
-- CASCADE the redemptions table relies on.
CREATE TABLE coupon_products (
  coupon_id  TEXT NOT NULL REFERENCES coupons(id)  ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (coupon_id, product_id)
);
CREATE INDEX idx_coupon_products_product ON coupon_products(product_id);
