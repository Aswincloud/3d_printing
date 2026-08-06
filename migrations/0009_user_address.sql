-- 0009_user_address.sql — saved delivery address on an account
--
-- Checkout asks for the same seven fields every time. A returning customer types
-- their address again on every order, which is the most common reason a repeat
-- purchase is abandoned on a phone. These let an account remember it.
--
-- Mirrors the columns on `orders` exactly (addr_line / addr_city / addr_state /
-- addr_pin, plus phone) so prefill is a straight field-for-field copy with no
-- mapping layer to get wrong.
--
-- The ORDER still snapshots its own copy. This is a convenience default, not the
-- record of where something was sent: editing your saved address must never
-- rewrite where a past parcel went, which is the same reason order_items
-- snapshots name and price rather than joining to products.
--
-- All nullable — an account created by OTP has none of this until the customer
-- either fills the settings form or checks out once.
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN addr_line TEXT;
ALTER TABLE users ADD COLUMN addr_city TEXT;
ALTER TABLE users ADD COLUMN addr_state TEXT;
ALTER TABLE users ADD COLUMN addr_pin TEXT;
