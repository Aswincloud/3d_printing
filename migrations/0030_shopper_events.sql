-- Shopper activity (2026-10-22): what visitors do on the way to buying — viewed a
-- product, added to cart, opened checkout, pressed Pay — so the owner can see in
-- the dashboard that someone is shopping, guests included (a guest's cart lives
-- only in their browser, so nothing else records it).
--
-- Deliberately thin: a random per-browser id (not an account, not an IP), the
-- event, an optional product and quantity, and the order it led to once Pay
-- creates one. No name, email, phone or address is ever written here. Rows older
-- than 30 days are pruned on write.
CREATE TABLE IF NOT EXISTS shopper_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sid        TEXT NOT NULL,             -- random per-browser id, 16 hex
  kind       TEXT NOT NULL,             -- view | cart_add | cart_remove | checkout_open | pay_click
  product_id TEXT,                      -- a real product, or NULL
  qty        INTEGER,
  user_id    TEXT,                      -- signed-in visitor, from the session cookie only
  receipt    TEXT,                      -- the order a pay_click led to
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shopper_events_time ON shopper_events(created_at);
CREATE INDEX IF NOT EXISTS idx_shopper_events_sid ON shopper_events(sid, created_at);
