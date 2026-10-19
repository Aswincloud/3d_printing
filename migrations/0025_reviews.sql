-- Customer reviews on product pages (2026-10-19).
--
-- Anyone may post one; the owner is emailed each time and can delete any. A
-- review is marked VERIFIED only when the server finds a paid order for that
-- product under the reviewer's own signed-in account — never from anything the
-- form sends. The owner can also add a review a real customer sent elsewhere
-- (WhatsApp, Instagram), recorded with source='owner' and labelled with where it
-- came from; the shop does not invent reviews.
CREATE TABLE reviews (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  user_id     TEXT,                       -- the signed-in reviewer, if any
  order_id    TEXT,                       -- the paid order that verified it
  source      TEXT NOT NULL DEFAULT 'site', -- 'site' | 'owner'
  source_note TEXT NOT NULL DEFAULT '',   -- for owner-added: "via WhatsApp"
  ip_hash     TEXT NOT NULL DEFAULT '',   -- rate limiting only; never shown
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_reviews_product ON reviews(product_id, created_at DESC);
CREATE INDEX idx_reviews_ip ON reviews(ip_hash, created_at);
